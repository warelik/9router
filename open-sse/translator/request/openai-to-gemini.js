import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { DEFAULT_THINKING_AG_SIGNATURE, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { openaiToClaudeRequestForAntigravity } from "./openai-to-claude.js";
import { safeParseJSON } from "../concerns/json.js";
import { getGeminiThoughtSignatureSync, findGeminiTurnSignature, geminiTurnScope, getGeminiServerPartsSync, findGeminiServerPartsForTurn } from "../../services/thoughtSignatureStore.js";
function generateUUID() {
  return crypto.randomUUID();
}

import {
  DEFAULT_SAFETY_SETTINGS,
  convertOpenAIContentToParts,
  extractTextContent,
  tryParseJSON,
  generateRequestId,
  generateSessionId,
  generateProjectId,
  cleanJSONSchemaForAntigravity,
  lowerProtoSchemaTypes,
  isLegacyGeminiSchema,
  normalizeGeminiContents,
  GEMINI_RESERVED_RESPONSE_KEYS
} from "../formats/gemini.js";
import { deriveSessionId, toNumericSessionId } from "../../utils/sessionManager.js";
import {
  ROLE, GEMINI_ROLE, OPENAI_BLOCK, CLAUDE_BLOCK,
  OPENAI_TOOL_CHOICE_AUTO, OPENAI_TOOL_CHOICE_NONE, OPENAI_TOOL_CHOICE_REQUIRED,
  GEMINI_FUNCTION_CALLING_MODE_AUTO, GEMINI_FUNCTION_CALLING_MODE_NONE,
  GEMINI_FUNCTION_CALLING_MODE_ANY, GEMINI_FUNCTION_CALLING_MODE_VALIDATED,
} from "../schema/index.js";
import { isGemini4Model } from "../../providers/capabilities.js";

// Sanitize function names for Gemini API.
// Gemini requires: starts with [a-zA-Z_], followed by [a-zA-Z0-9_.:\-], max 64 chars.
// Replace any invalid character with '_' and truncate to 64.
function sanitizeGeminiFunctionName(name) {
  if (!name) return "_unknown";
  // Replace any char not in [a-zA-Z0-9_.:\-] with '_'
  let sanitized = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  // First char must be letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  // Truncate to 64 chars
  return sanitized.substring(0, 64);
}

function buildFunctionDeclaration(name, description, schema) {
  const decl = { name: sanitizeGeminiFunctionName(name), description: description || "" };
  if (schema === undefined || schema === null) return decl;
  if (typeof schema !== "object") {
    decl.parametersJsonSchema = schema;
    return decl;
  }
  const cleaned = isLegacyGeminiSchema(schema) ? cleanJSONSchemaForAntigravity(structuredClone(schema)) : null;
  if (cleaned !== null && JSON.stringify(cleaned) === JSON.stringify(schema)) {
    decl.parameters = cleaned;
  } else {
    decl.parametersJsonSchema = lowerProtoSchemaTypes(structuredClone(schema));
  }
  return decl;
}

/**
 * Rewrites duplicate tool_call_ids so every emitted functionCall id is unique.
 *
 * Gemini validates functionCall id uniqueness across the WHOLE history and
 * answers 400 INVALID_ARGUMENT otherwise, but an OpenAI tool_call_id is only
 * unique within its own assistant turn — a long agent session can replay the
 * same id in a later turn (#4532).
 *
 * Uniqueness is per OCCURRENCE, not per id: two different calls that share an id
 * must end up with different emitted ids, so the mapping is consumed in
 * document order rather than memoized by id. Each call site calls next() once
 * per emitted functionCall, and keeps the returned value so the matching
 * functionResponse reuses it.
 *
 * Ids that were already unique are passed through untouched, so a valid
 * conversation is byte-identical to before.
 */
function createToolCallIdUniquifier() {
  const used = new Set();
  return {
    next(id) {
      if (!id) return id;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
      let n = 2;
      let candidate = `${id}-${n}`;
      // An id may already end in "-2"; keep counting rather than collide again.
      while (used.has(candidate)) candidate = `${id}-${n++}`;
      used.add(candidate);
      return candidate;
    },
  };
}

function appendInstructionParts(parts, content) {
  if (typeof content === "string") {
    if (content) parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === OPENAI_BLOCK.TEXT && typeof block.text === "string") {
        parts.push({ text: block.text });
      }
    }
  }
}

// Core: Convert OpenAI request to Gemini format (base for all variants)
function openaiToGeminiBase(model, body, stream, signature = DEFAULT_THINKING_AG_SIGNATURE, sessionId = null, serverPartsSessionId = null) {
  const result = {
    model: model,
    contents: [],
    generationConfig: {},
    safetySettings: DEFAULT_SAFETY_SETTINGS
  };

  // Generation config — Gemini 4 removed the sampling params, forwarding them fails the request
  const allowSampling = !isGemini4Model(model);
  if (allowSampling && body.temperature !== undefined) {
    result.generationConfig.temperature = body.temperature;
  }
  if (allowSampling && body.top_p !== undefined) {
    result.generationConfig.topP = body.top_p;
  }
  if (allowSampling && body.top_k !== undefined) {
    result.generationConfig.topK = body.top_k;
  }
  const maxOutput = body.max_completion_tokens !== undefined ? body.max_completion_tokens : body.max_tokens;
  if (maxOutput !== undefined) {
    result.generationConfig.maxOutputTokens = maxOutput;
  }
  if (typeof body.stop === "string") {
    result.generationConfig.stopSequences = [body.stop];
  } else if (Array.isArray(body.stop)) {
    result.generationConfig.stopSequences = [...body.stop];
  }
  if (body.seed !== undefined) {
    result.generationConfig.seed = body.seed;
  }
  if (body.presence_penalty !== undefined) {
    result.generationConfig.presencePenalty = body.presence_penalty;
  }
  if (body.frequency_penalty !== undefined) {
    result.generationConfig.frequencyPenalty = body.frequency_penalty;
  }

  const applyJsonOutput = (schema) => {
    result.generationConfig.responseMimeType = "application/json";
    if (schema !== undefined) result.generationConfig.responseJsonSchema = schema;
  };
  const textFormat = body.text?.format;
  if (textFormat?.type === "json_object") {
    applyJsonOutput();
  } else if (textFormat?.type === "json_schema") {
    applyJsonOutput(textFormat.schema);
  }
  const responseFormat = body.response_format;
  if (responseFormat?.type === "json_object") {
    applyJsonOutput();
  } else if (responseFormat?.type === "json_schema") {
    applyJsonOutput(responseFormat.json_schema?.schema ?? responseFormat.json_schema);
  }

  const instructionParts = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m.role !== ROLE.SYSTEM && m.role !== ROLE.DEVELOPER) continue;
      appendInstructionParts(instructionParts, m.content);
    }
  }
  // The outgoing request carries all instructions. Earlier cached turns use only
  // the instruction prefix that existed when their responses were produced.
  const finalSystem = instructionParts.length > 0
    ? { role: GEMINI_ROLE.USER, parts: instructionParts }
    : null;
  if (finalSystem) result.systemInstruction = finalSystem;

  // Build tool_call_id -> name map
  const tcID2Name = new Map();

  // Calls awaiting their results, keyed by ORIGINAL tool_call_id. The same id may
  // be reused by several calls (a later turn, or sibling calls in one turn), so each
  // id has a FIFO queue and every real tool message consumes the oldest queued call.
  const pendingToolCalls = new Map();
  // Emitted functionCall ids must be unique across the whole history.
  const toolCallIdUniquifier = createToolCallIdUniquifier();
  const turnInstructionParts = [];

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const role = msg.role;
      const content = msg.content;

      if (role === ROLE.SYSTEM || role === ROLE.DEVELOPER) {
        appendInstructionParts(turnInstructionParts, content);
        continue;
      } else if (role === ROLE.USER) {
        const parts = convertOpenAIContentToParts(content);
        if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.USER, parts });
        }
      } else if (role === ROLE.ASSISTANT) {
        const parts = [];

        const text = content ? (typeof content === "string" ? content : extractTextContent(content)) : "";
        const turnSystem = turnInstructionParts.length > 0
          ? { role: GEMINI_ROLE.USER, parts: turnInstructionParts }
          : null;
        const turnScope = geminiTurnScope(result.contents, turnSystem);
        // Signature the provider issued for this tool-free turn (Gemini only accepts its own).
        const turnSig = msg.tool_calls?.length
          ? null
          : findGeminiTurnSignature({ reasoning: msg.reasoning_content, content: text, scope: turnScope, sessionId: serverPartsSessionId }, model);
        // Server-side tool parts (googleSearch toolCall/toolResponse) that preceded the
        // text of this turn must go back verbatim or Gemini 3 rejects the request.
        const serverTurnParts = findGeminiServerPartsForTurn({ reasoning: msg.reasoning_content, content: text, scope: turnScope, sessionId: serverPartsSessionId }, model);

        // Thinking/reasoning → thought part with signature
        if (msg.reasoning_content) {
          parts.push({
            thought: true,
            text: msg.reasoning_content
          });
          if (!turnSig) {
            parts.push({
              thoughtSignature: signature,
              text: ""
            });
          }
        }

        const contentParts = typeof content === "string"
          ? (content ? [{ text: content }] : [])
          : convertOpenAIContentToParts(content);
        if (serverTurnParts) parts.push(...serverTurnParts);
        if (contentParts.length > 0) {
          const [first, ...rest] = contentParts;
          parts.push(turnSig ? { ...first, thoughtSignature: turnSig } : first);
          parts.push(...rest);
        } else if (turnSig) {
          parts.push({ thoughtSignature: turnSig, text: "" });
        }

        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          let firstFunctionCallSeen = false;
          for (const tc of msg.tool_calls) {
            if (tc.type !== OPENAI_BLOCK.FUNCTION) continue;
            if (tc.id && tc.function?.name) tcID2Name.set(tc.id, tc.function.name);

            const args = tryParseJSON(tc.function?.arguments || "{}");
            const cachedSig = tc.id ? getGeminiThoughtSignatureSync(tc.id, sessionId, model) : null;
            // First call gets cached signature or fallback; sibling calls remain unsigned if no cached sig
            const callSig = cachedSig || (!firstFunctionCallSeen ? signature : undefined);
            firstFunctionCallSeen = true;

            const serverParts = tc.id ? getGeminiServerPartsSync(tc.id, serverPartsSessionId, model, turnScope) : null;
            if (serverParts) parts.push(...serverParts);
            // Emitted id is uniquified; signature and server-part lookups stay on
            // the ORIGINAL id so cached entries are still found.
            const emitId = toolCallIdUniquifier.next(tc.id);

            const part = {
              functionCall: {
                id: emitId,
                name: sanitizeGeminiFunctionName(tc.function.name),
                args: args
              }
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
            if (tc.id) {
              if (!pendingToolCalls.has(tc.id)) pendingToolCalls.set(tc.id, []);
              pendingToolCalls.get(tc.id).push({ name: tc.function?.name, emitId });
            }
          }

          if (parts.length > 0) {
            result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
          }
        } else if (parts.length > 0) {
          result.contents.push({ role: GEMINI_ROLE.MODEL, parts });
        }
      } else if (role === ROLE.TOOL) {
        // Tool results come from their own role:tool messages
        const fid = msg.tool_call_id;
        // The oldest preceding call that used this id answers this result.
        const pendingCall = fid ? pendingToolCalls.get(fid)?.shift() : undefined;
        // Resolve the function name from preceding calls
        let name = pendingCall?.name || (fid ? tcID2Name.get(fid) : undefined);
        if (!name && fid) {
          const idParts = fid.split("-");
          name = idParts.length > 2 ? idParts.slice(0, -2).join("-") : fid;
        }

        const parsed = safeParseJSON(msg.content, msg.content);
        let response = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
          ? parsed
          : { result: parsed ?? null };
        const serialized = JSON.stringify(response);
        if (Object.keys(GEMINI_RESERVED_RESPONSE_KEYS).some(key => serialized.includes(`${JSON.stringify(key)}:`))) {
          response = { result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
        }

        const functionResponse = { name: sanitizeGeminiFunctionName(name || "tool"), response };
        const responseId = pendingCall ? pendingCall.emitId : fid;
        if (responseId) functionResponse.id = responseId;
        result.contents.push({ role: GEMINI_ROLE.USER, parts: [{ functionResponse }] });
      }
    }
  }

  if (result.contents.length === 0 && result.systemInstruction) {
    result.contents.push({ role: GEMINI_ROLE.USER, parts: [{ text: "..." }] });
  }

  // Convert tools
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const functionDeclarations = [];
    for (const t of body.tools) {
      // Check if already in Anthropic/Claude format (no type field, direct name/description/input_schema)
      if (t.name && t.input_schema) {
        functionDeclarations.push(buildFunctionDeclaration(t.name, t.description, t.input_schema));
      }
      // OpenAI format
      else if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
        const fn = t.function;
        functionDeclarations.push(buildFunctionDeclaration(fn.name, fn.description, fn.parameters));
      }
    }

    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];

      const choice = body.tool_choice;
      if (choice === OPENAI_TOOL_CHOICE_AUTO) {
        result.toolConfig = { functionCallingConfig: { mode: GEMINI_FUNCTION_CALLING_MODE_AUTO } };
      } else if (choice === OPENAI_TOOL_CHOICE_NONE) {
        result.toolConfig = { functionCallingConfig: { mode: GEMINI_FUNCTION_CALLING_MODE_NONE } };
      } else if (choice === OPENAI_TOOL_CHOICE_REQUIRED) {
        result.toolConfig = { functionCallingConfig: { mode: GEMINI_FUNCTION_CALLING_MODE_ANY } };
      } else if (choice && typeof choice === "object") {
        const named = choice.function?.name ?? choice.name;
        if (typeof named === "string" && named) {
          result.toolConfig = {
            functionCallingConfig: {
              mode: GEMINI_FUNCTION_CALLING_MODE_ANY,
              allowedFunctionNames: [sanitizeGeminiFunctionName(named)]
            }
          };
        }
      }
    }
  }

  if (body._customToolNames) result._customToolNames = body._customToolNames;
  if (body._toolNameMap) result._toolNameMap = body._toolNameMap;
  if (body._webSearch) result._webSearch = body._webSearch;

  result.contents = normalizeGeminiContents(result.contents, model, { synthesizeTerminalToolResponse: false });
  return result;
}

// OpenAI -> Gemini (standard API)
export function openaiToGeminiRequest(model, body, stream, credentials = null) {
  const result = openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_AG_SIGNATURE, credentials?._clientSessionId, credentials?._geminiServerPartsSessionId || null);
  // The response of this request is a new turn of this exact history (see geminiTurnScope).
  if (credentials) credentials._geminiTurnScope = geminiTurnScope(result.contents, result.systemInstruction);
  return result;
}

// OpenAI -> Gemini CLI (Cloud Code Assist)
export function openaiToGeminiCLIRequest(model, body, stream, credentials = null) {
  const gemini = openaiToGeminiBase(model, body, stream, DEFAULT_THINKING_GEMINI_CLI_SIGNATURE, credentials?._clientSessionId, credentials?._geminiServerPartsSessionId || null);
  if (credentials) credentials._geminiTurnScope = geminiTurnScope(gemini.contents, gemini.systemInstruction);
  // Thinking is normalized centrally by applyThinking (thinkingUnified.js) after translation.

  // Schema compatibility is handled once in the base converter
  // if (isClaude) {
  //   fn.parameters = cleanedSchema;
  // } else {
  //   fn.parametersJsonSchema = cleanedSchema;
  //   delete fn.parameters;
  // }

  return gemini;
}

// Wrap Gemini CLI format in Cloud Code wrapper
function wrapInCloudCodeEnvelope(model, geminiCLI, credentials = null, isAntigravity = false) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: isAntigravity ? "antigravity" : "gemini-cli",
    requestId: isAntigravity ? `agent-${generateUUID()}` : generateRequestId(),
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || (isAntigravity ? deriveSessionId(credentials?.email || credentials?.connectionId) : generateSessionId()),
      contents: geminiCLI.contents,
      systemInstruction: geminiCLI.systemInstruction,
      generationConfig: geminiCLI.generationConfig,
      tools: geminiCLI.tools,
    }
  };

  // Antigravity specific fields.
  // NOTE: the official Antigravity client omits `requestType` entirely on the
  // agent (chat) path. Sending `requestType: "agent"` triggers a detail-free
  // 429 RESOURCE_EXHAUSTED even with quota available.
  if (!isAntigravity) {
    // Keep safetySettings for Gemini CLI
    envelope.request.safetySettings = geminiCLI.safetySettings;
  }

  if (geminiCLI.tools?.length > 0) {
    envelope.request.toolConfig = geminiCLI.toolConfig || {
      functionCallingConfig: { mode: GEMINI_FUNCTION_CALLING_MODE_VALIDATED }
    };
  }

  if (geminiCLI._customToolNames) envelope._customToolNames = geminiCLI._customToolNames;
  if (geminiCLI._toolNameMap) envelope._toolNameMap = geminiCLI._toolNameMap;

  return envelope;
}

// Wrap Claude format in Cloud Code envelope for Antigravity
function wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials = null, signature = DEFAULT_THINKING_AG_SIGNATURE) {
  const projectId = credentials?.projectId || generateProjectId();

  const envelope = {
    project: projectId,
    model: model,
    userAgent: "antigravity",
    requestId: `agent-${generateUUID()}`,
    // NOTE: official Antigravity client omits `requestType` on the agent (chat)
    // path — see the note in wrapInCloudCodeEnvelope() above.
    request: {
      sessionId: toNumericSessionId(credentials?._clientSessionId) || deriveSessionId(credentials?.email || credentials?.connectionId),
      contents: [],
      generationConfig: {
        temperature: claudeRequest.temperature || 1,
        maxOutputTokens: claudeRequest.max_tokens || 4096
      }
    }
  };

  // Build tool_use id -> name map so functionResponse can use the correct name
  const toolUseIdToName = {};
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE && block.id && block.name) {
            toolUseIdToName[block.id] = block.name;
          }
        }
      }
    }
  }

  // Convert Claude messages to Gemini contents
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    for (const msg of claudeRequest.messages) {
      const parts = [];

      if (Array.isArray(msg.content)) {
        let firstToolUseSeen = false;
        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TEXT) {
            parts.push({ text: block.text });
          } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            const cachedSig = block.id ? getGeminiThoughtSignatureSync(block.id, credentials?._clientSessionId, model) : null;
            const callSig = cachedSig || (!firstToolUseSeen ? signature : undefined);
            firstToolUseSeen = true;

            const part = {
              functionCall: {
                id: block.id,
                name: sanitizeGeminiFunctionName(block.name),
                args: block.input || {}
              }
            };
            if (callSig) {
              part.thoughtSignature = callSig;
            }
            parts.push(part);
          } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
            let content = block.content;
            if (Array.isArray(content)) {
              content = content.map(c => c.type === CLAUDE_BLOCK.TEXT ? c.text : JSON.stringify(c)).join("\n");
            }
            // Resolve the original tool name from the id — Gemini requires it to match the functionCall name
            const resolvedName = toolUseIdToName[block.tool_use_id]
              ? sanitizeGeminiFunctionName(toolUseIdToName[block.tool_use_id])
              : "tool";
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: resolvedName,
                response: { result: tryParseJSON(content) || content }
              }
            });
          }
        }
      } else if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        envelope.request.contents.push({
          role: msg.role === ROLE.ASSISTANT ? GEMINI_ROLE.MODEL : GEMINI_ROLE.USER,
          parts
        });
      }
    }
  }

  // Convert Claude tools to Gemini functionDeclarations
  if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
    const functionDeclarations = [];
    for (const tool of claudeRequest.tools) {
      if (tool.name && tool.input_schema) {
        const cleanedSchema = cleanJSONSchemaForAntigravity(tool.input_schema);
        functionDeclarations.push({
          name: sanitizeGeminiFunctionName(tool.name),
          description: tool.description || "",
          parameters: cleanedSchema
        });
      }
    }
    if (functionDeclarations.length > 0) {
      envelope.request.tools = [{ functionDeclarations }];
      envelope.request.toolConfig = {
        functionCallingConfig: { mode: GEMINI_FUNCTION_CALLING_MODE_VALIDATED }
      };
    }
  }

  const systemParts = [];
  // Merge user system prompt from claudeRequest
  if (claudeRequest.system) {
    if (Array.isArray(claudeRequest.system)) {
      for (const block of claudeRequest.system) {
        if (block.text) systemParts.push({ text: block.text });
      }
    } else if (typeof claudeRequest.system === "string") {
      systemParts.push({ text: claudeRequest.system });
    }
  }

  if (systemParts.length > 0) {
    envelope.request.systemInstruction = { role: GEMINI_ROLE.USER, parts: systemParts };
  }

  if (claudeRequest._customToolNames) envelope._customToolNames = claudeRequest._customToolNames;
  if (claudeRequest._toolNameMap) envelope._toolNameMap = claudeRequest._toolNameMap;

  envelope.request.contents = normalizeGeminiContents(envelope.request.contents, model);
  return envelope;
}

// Detect if model should use Claude backend in Antigravity
// Claude models have specific ID patterns — more reliable than caps at routing level
function isClaudeModel(model) {
  return model.toLowerCase().includes("claude");
}

// OpenAI -> Antigravity (Sandbox Cloud Code with wrapper)
export function openaiToAntigravityRequest(model, body, stream, credentials = null) {
  if (isClaudeModel(model)) {
    const claudeRequest = openaiToClaudeRequestForAntigravity(model, body, stream);
    return wrapInCloudCodeEnvelopeForClaude(model, claudeRequest, credentials);
  }

  const geminiCLI = openaiToGeminiCLIRequest(model, body, stream, credentials);
  return wrapInCloudCodeEnvelope(model, geminiCLI, credentials, true);
}

// Register
register(FORMATS.OPENAI, FORMATS.GEMINI, openaiToGeminiRequest, null);
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, (model, body, stream, credentials) => wrapInCloudCodeEnvelope(model, openaiToGeminiCLIRequest(model, body, stream, credentials), credentials), null);
register(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, openaiToAntigravityRequest, null);
