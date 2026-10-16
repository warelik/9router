import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, OPENAI_FINISH, DEFAULT_IMAGE_MIME } from "../schema/index.js";
import { buildChunk } from "../concerns/chunk.js";
import { toOpenAIUsage } from "../concerns/usage.js";
import { reasoningDelta } from "../concerns/reasoning.js";
import { encodeDataUri } from "../concerns/image.js";
import { toOpenAIFinish } from "../concerns/finishReason.js";
import { resolveToolName } from "../../utils/opencodeFingerprint.js";
import { storeGeminiThoughtSignature, storeGeminiTurnSignature, storeGeminiServerParts, storeGeminiServerPartsForTurn } from "../../services/thoughtSignatureStore.js";

// Build chunk meta for current gemini state
function chunkMeta(state) {
  return { id: `chatcmpl-${state.messageId}`, created: Math.floor(Date.now() / 1000), model: state.model };
}

// Build a tool_call chunk from a gemini functionCall part (shared by sig/non-sig branches)
function emitFunctionCall(functionCall, state, signature = null) {
  const rawName = functionCall.name;
  // Restore original tool name from mapping (AG cloaking)
  const fcName = state.toolNameMap ? resolveToolName(rawName, state.toolNameMap).name : rawName;
  const fcArgs = functionCall.args || {};
  const toolCallIndex = state.functionIndex++;
  const callId = functionCall.id || `${fcName}-${Date.now()}-${toolCallIndex}`;
  if (signature) {
    storeGeminiThoughtSignature(callId, signature, state.sessionId, state.model);
  }
  // Server-side parts accumulated so far in this turn belong to this call: they
  // must be replayed verbatim ahead of its functionCall on later requests.
  if (state.geminiServerParts?.length) {
    storeGeminiServerParts(callId, state.geminiServerParts, state.serverPartsSessionId, state.model, state.turnScope);
    state.geminiServerParts = [];
  }
  const toolCall = {
    id: callId,
    index: toolCallIndex,
    type: OPENAI_BLOCK.FUNCTION,
    function: { name: fcName, arguments: JSON.stringify(fcArgs) },
  };
  // Keep Gemini bookkeeping separate from the shared translator state.toolCalls map.
  // The downstream OpenAI→Claude translator uses state.toolCalls for Claude block
  // metadata; pre-populating it here makes Anthropic tool deltas lose index.
  state.geminiToolCallCount = (state.geminiToolCallCount || 0) + 1;
  return buildChunk(chunkMeta(state), { tool_calls: [toolCall] }, null);
}

// Emit a text part as reasoning/content and remember it for the turn signature (see finish).
function emitText(part, isThought, state) {
  if (isThought) state.turnReasoning = (state.turnReasoning || "") + part.text;
  else state.turnContent = (state.turnContent || "") + part.text;
  return buildChunk(
    chunkMeta(state),
    isThought ? reasoningDelta(part.text) : { content: part.text },
    null
  );
}

// Convert Gemini response chunk to OpenAI format
export function geminiToOpenAIResponse(chunk, state) {
  if (!chunk) return null;
  
  // Handle Antigravity wrapper
  const response = chunk.response || chunk;
  if (!response || !response.candidates?.[0]) return null;

  const results = [];
  const candidate = response.candidates[0];
  const content = candidate.content;

  // Initialize state
  if (!state.messageId) {
    state.messageId = response.responseId || `msg_${Date.now()}`;
    state.model = response.modelVersion || state.model || "gemini";
    state.functionIndex = 0;
    state.geminiToolCallCount = 0;
    results.push(buildChunk(chunkMeta(state), { role: ROLE.ASSISTANT }, null));
  }

  // Process parts
  if (content?.parts) {
    for (const part of content.parts) {
      // Server-executed tool parts (googleSearch on Gemini 3) never reach the client;
      // capture them verbatim, in order, without letting their signatures become the
      // pending signature of the following functionCall.
      if (part.toolCall || part.toolResponse) {
        (state.geminiServerParts ??= []).push(part);
        continue;
      }
      const hasThoughtSig = part.thoughtSignature || part.thought_signature;
      if (hasThoughtSig && typeof hasThoughtSig === "string") {
        state.pendingThoughtSignature = hasThoughtSig;
      }
      const isThought = part.thought === true;

      // Handle thought signature (thinking mode)
      if (hasThoughtSig) {
        const hasTextContent = part.text !== undefined && part.text !== "";
        const hasFunctionCall = !!part.functionCall;

        // Standalone thoughtSignature part (no text, no functionCall): keep pending for next functionCall
        if (!hasTextContent && !hasFunctionCall) {
          continue;
        }

        if (hasTextContent) {
          results.push(emitText(part, isThought, state));
        }

        if (hasFunctionCall) {
          results.push(emitFunctionCall(part.functionCall, state, hasThoughtSig));
          state.pendingThoughtSignature = null;
        }
        continue;
      }

      // Text content. Gemini marks model-internal thinking with `thought: true`.
      // Some responses include a thoughtSignature, but Google AI Studio/Gemini API
      // can also stream thought parts without a signature; those must not be
      // surfaced as normal assistant content in OpenAI-compatible clients.
      if (part.text !== undefined && part.text !== "") {
        results.push(emitText(part, isThought, state));
      }

      // Function call
      if (part.functionCall) {
        const sig = state.pendingThoughtSignature || null;
        results.push(emitFunctionCall(part.functionCall, state, sig));
        state.pendingThoughtSignature = null;
      }

      // Inline data (images)
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) {
        const mimeType = inlineData.mimeType || inlineData.mime_type || DEFAULT_IMAGE_MIME;
        results.push(buildChunk(
          chunkMeta(state),
          {
            images: [{
              type: OPENAI_BLOCK.IMAGE_URL,
              image_url: { url: encodeDataUri(mimeType, inlineData.data) }
            }]
          },
          null
        ));
      }
    }
  }

  // Usage metadata - extract before finish reason so we can include it
  const usageMeta = response.usageMetadata || chunk.usageMetadata;
  const geminiUsage = toOpenAIUsage(usageMeta, "gemini");
  if (geminiUsage) state.usage = geminiUsage;

  // Finish reason - include usage in final chunk
  if (candidate.finishReason) {
    // Server parts that never preceded a functionCall belong to a turn that ended on
    // text; anchor them to the turn key so the next request can replay them.
    if (state.geminiServerParts?.length) {
      storeGeminiServerPartsForTurn(
        { reasoning: state.turnReasoning, content: state.turnContent, scope: state.turnScope, sessionId: state.serverPartsSessionId },
        state.geminiServerParts,
        state.model
      );
      state.geminiServerParts = [];
    }
    // A signature still pending at the end of a turn without tool calls belongs to the
    // thinking that produced this text; keep it so the next request can replay it.
    if (state.pendingThoughtSignature && state.geminiToolCallCount === 0) {
      storeGeminiTurnSignature(
        { reasoning: state.turnReasoning, content: state.turnContent, scope: state.turnScope },
        state.pendingThoughtSignature,
        state.model
      );
      state.pendingThoughtSignature = null;
    }
    let finishReason = toOpenAIFinish(candidate.finishReason, "gemini");
    if (finishReason === OPENAI_FINISH.STOP && state.geminiToolCallCount > 0) {
      finishReason = OPENAI_FINISH.TOOL_CALLS;
    }
    
    const finalChunk = buildChunk(chunkMeta(state), {}, finishReason);
    
    // Include usage in final chunk for downstream translators
    if (state.usage) {
      finalChunk.usage = state.usage;
    }
    
    results.push(finalChunk);
    state.finishReason = finishReason;
  }

  return results.length > 0 ? results : null;
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, null, geminiToOpenAIResponse);
register(FORMATS.VERTEX, FORMATS.OPENAI, null, geminiToOpenAIResponse);

