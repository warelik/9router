import { FORMATS } from "../translator/formats.js";
import { fallbackToolCallId } from "../translator/concerns/toolCall.js";
import { buildErrorBody } from "./error.js";
import { SSE_DONE } from "./sseConstants.js";

const sharedEncoder = new TextEncoder();

function nativeResponseProjectionAllowsEmpty(projection) {
  return projection?.masks?.some(value => {
    const mask = String(value ?? "").trim();
    return mask.length > 0 && mask !== "*";
  }) || false;
}

export function isValidNativeGeminiResponse(response, projection = null, allowUnrecognized = false) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const allowsEmpty = nativeResponseProjectionAllowsEmpty(projection);
  if (!allowsEmpty && Object.keys(response).length === 0) return false;
  if (response.error) return true;

  const nativeResponse = response.response || response;
  if (!nativeResponse || typeof nativeResponse !== "object" || Array.isArray(nativeResponse)) return false;
  if (!allowsEmpty && Object.keys(nativeResponse).length === 0) return false;
  if (nativeResponse.error) return true;
  // GenerateContent metadata can be the whole reply. Keep unknown extensions
  // opaque, while requiring a recognizable reply unless a mask projects it out.
  const nativeFields = ["candidates", "promptFeedback", "usageMetadata", "modelVersion", "responseId", "modelStatus", "createTime"];
  if (!allowsEmpty && !allowUnrecognized && !nativeFields.some(field => Object.hasOwn(nativeResponse, field))) return false;
  if (nativeResponse.candidates !== undefined) {
    if (!Array.isArray(nativeResponse.candidates)) return false;
    for (const candidate of nativeResponse.candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      if (candidate.content === undefined) continue;
      const content = candidate.content;
      if (!content || typeof content !== "object" || Array.isArray(content)) return false;
      if (content.parts !== undefined && (
        !Array.isArray(content.parts)
        || content.parts.some(part => !part || typeof part !== "object" || Array.isArray(part))
      )) return false;
    }
  }
  return true;
}

// Parse SSE data line
export function parseSSELine(line, format = null) {
  if (!line) return null;

  // NDJSON format (Ollama): raw JSON lines without "data:" prefix
  if (format === FORMATS.OLLAMA) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  // Standard SSE format: "data: {...}"
  if (line.charCodeAt(0) !== 100) return null; // 'd' = 100

  const data = line.slice(5).trim();
  if (data === "[DONE]") return { done: true };

  try {
    return JSON.parse(data);
  } catch (error) {
    if (data.length > 0 && data.length < 1000) {
      console.log(`[WARN] Failed to parse SSE line (${data.length} chars): ${data.substring(0, 100)}...`);
    }
    return null;
  }
}

// Check if chunk has valuable content (not empty)
export function hasValuableContent(chunk, format) {
  // OpenAI format
  if (format === FORMATS.OPENAI && chunk.choices?.[0]?.delta) {
    const delta = chunk.choices[0].delta;
    return delta.content && delta.content !== "" ||
           delta.reasoning_content && delta.reasoning_content !== "" ||
           delta.tool_calls && delta.tool_calls.length > 0 ||
           chunk.choices[0].finish_reason ||
           delta.role;
  }

  // Claude format
  if (format === FORMATS.CLAUDE) {
    const isContentBlockDelta = chunk.type === "content_block_delta";
    const hasText = chunk.delta?.text && chunk.delta.text !== "";
    const hasThinking = chunk.delta?.thinking && chunk.delta.thinking !== "";
    const hasInputJson = chunk.delta?.partial_json && chunk.delta.partial_json !== "";
    const hasSignature = chunk.delta?.signature && chunk.delta.signature !== "";
    
    if (isContentBlockDelta && !hasText && !hasThinking && !hasInputJson && !hasSignature) {
      return false;
    }
    return true;
  }

  return true; // Other formats: keep all chunks
}

// Ensure every streamed tool_call carries an id.
//
// OpenAI's streaming contract: the id and function.name arrive on the FIRST
// fragment of a tool call; later fragments carry only `index` + argument
// deltas. Some providers instead open a brand-new `index` in a late fragment
// and omit the id entirely. Strict OpenAI-compatible clients
// (@ai-sdk/openai-compatible) then throw
// "AI_InvalidResponseDataError: Expected 'id' to be a string." and abort the
// whole turn.
//
// Fix: remember the id per tool-call index, and mint one when a fragment
// opens an index the client has not seen yet. The id must be stable for the
// rest of the call, so a later fragment with the same index reuses it.
//
// Returns true when a chunk was modified.
export function ensureStreamToolCallIds(chunk, seenIds) {
  if (!chunk?.choices?.length) return false;
  let changed = false;

  for (const choice of chunk.choices) {
    const calls = choice?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;

    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;

      if (typeof tc.id === "string" && tc.id.length > 0) {
        if (tc.index !== undefined) seenIds.set(tc.index, tc.id);
        continue;
      }

      // No id on this fragment. Reuse the one already seen for this index, or
      // mint one when the index is new to the client.
      const known = tc.index !== undefined ? seenIds.get(tc.index) : undefined;
      const id = known || fallbackToolCallId(tc.index);
      tc.id = id;
      if (tc.index !== undefined) seenIds.set(tc.index, id);
      changed = true;
    }
  }

  return changed;
}

// Fix invalid id (generic or too short)
export function fixInvalidId(parsed) {
  if (parsed.id && (parsed.id === "chat" || parsed.id === "completion" || parsed.id.length < 8)) {
    const fallbackId = parsed.extend_fields?.requestId || 
                      parsed.extend_fields?.traceId || 
                      Date.now().toString(36);
    parsed.id = `chatcmpl-${fallbackId}`;
    return true;
  }
  return false;
}

function cleanUsagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  let cleaned = payload;

  if ("usage" in cleaned) {
    if (cleaned.usage === null) {
      const { usage, ...payloadWithoutUsage } = cleaned;
      cleaned = payloadWithoutUsage;
    } else if (typeof cleaned.usage === "object" && cleaned.usage.perf_metrics === null) {
      const { perf_metrics, ...usageWithoutPerf } = cleaned.usage;
      cleaned = { ...cleaned, usage: usageWithoutPerf };
    }
  }

  if (cleaned.response && typeof cleaned.response === "object" && !Array.isArray(cleaned.response)) {
    const cleanedResponse = cleanUsagePayload(cleaned.response);
    if (cleanedResponse !== cleaned.response) {
      cleaned = { ...cleaned, response: cleanedResponse };
    }
  }

  return cleaned;
}

// Format output as SSE
export function formatSSE(data, sourceFormat) {
  if (data === null || data === undefined) return "data: null\n\n";
  if (data && data.done) return "data: [DONE]\n\n";

  // OpenAI Responses API format
  if (data && data.event && data.data) {
    const cleanedEventData = cleanUsagePayload(data.data);
    return `event: ${data.event}\ndata: ${JSON.stringify(cleanedEventData)}\n\n`;
  }

  data = cleanUsagePayload(data);

  // Claude format
  if (sourceFormat === FORMATS.CLAUDE && data && data.type) {
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return `data: ${JSON.stringify(data)}\n\n`;
}

// Terminal frames for a stream that aborted after HTTP 200 was already sent, so
// the status code can no longer change. OpenAI-compatible clients (openai-python
// raises APIError on any `data:` payload carrying an `error` key, checked before
// [DONE]) need the error frame first, then [DONE]; Anthropic clients need
// `event: error`. Never fabricate a successful finish_reason instead.
//
// Returns encoded bytes: onAbortTerminal callbacks are enqueued verbatim, same
// as buildAbortedResponsesTerminalBytes.
//
// NOTE: non-SSE client formats (Ollama NDJSON) get an SSE frame here — dead in
// practice because detectFormatByEndpoint never resolves to OLLAMA.
export function buildStreamErrorBytes(statusCode, message, clientFormat) {
  const { error } = buildErrorBody(statusCode, message);

  if ([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY].includes(clientFormat)) {
    // Gemini clients decode every data payload as JSON and terminate at EOF.
    // Keep the numeric failure code instead of an OpenAI symbolic error code.
    return sharedEncoder.encode(formatSSE({ error: { code: statusCode, message: error.message } }, clientFormat));
  }

  const sse = clientFormat === FORMATS.CLAUDE
    ? formatSSE({ type: "error", error }, FORMATS.CLAUDE)
    : formatSSE({ error }, clientFormat) + SSE_DONE;

  return sharedEncoder.encode(sse);
}
