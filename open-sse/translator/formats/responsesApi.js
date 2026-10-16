import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "..." }] }];
    }
    return input;
  }
  return null;
}

// Strict Responses upstreams reject overlong call_ids with InputValidationError (#393).
export const MAX_RESPONSES_CALL_ID_LEN = 64;

// OpenAI reasoning items carry Fernet-encrypted blobs; other providers' own
// encrypted_content values use different ciphertexts and must be preserved.
export const FERNET_ENCRYPTED_CONTENT_PREFIX = "gAAAAA";

// Codex's observed plaintext task carrier (an agent_message encrypted_content part) is converted
// here to input_text; known OpenAI Fernet ciphertext stays opaque.
export function normalizeResponsesAgentMessage(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "agent_message") return item;
  const content = Array.isArray(item.content)
    ? item.content.map((part) => (part?.type === "encrypted_content"
        && typeof part.encrypted_content === "string"
        && !part.encrypted_content.startsWith(FERNET_ENCRYPTED_CONTENT_PREFIX)
      ? { type: RESPONSES_ITEM.INPUT_TEXT, text: part.encrypted_content }
      : part))
    : item.content;
  return { ...item, type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content };
}

function reasoningHasReadableText(item) {
  const blocks = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];
  return blocks.some((b) =>
    (typeof b === "string" && b.trim() !== "")
    || (typeof b?.text === "string" && b.text.trim() !== ""));
}

/**
 * Rewrite provider-specific Responses input items into portable shapes.
 * Codex CLI histories contain multi-agent and delegation items that strict
 * Responses upstreams (e.g. Kimi Code) reject with 400:
 * - agent_message → user message built from its input_text parts and plaintext encrypted_content
 *   task carriers (dropped if none); Fernet ciphertext parts are left out
 * - function_call_output/custom_tool_call_output without call_id → user message
 *   from its output (string as-is; array → input_text/input_image parts; dropped if empty)
 * - reasoning whose encrypted_content is an OpenAI Fernet token and which carries
 *   no readable summary/content text → dropped (undecryptable for other providers)
 * Everything else is returned as the same object; the caller's array is not mutated.
 */
export function toPortableResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      out.push(item);
      continue;
    }
    if (item.type === "agent_message") {
      const message = normalizeResponsesAgentMessage(item);
      const parts = Array.isArray(message.content)
        ? message.content.filter((c) => c?.type === RESPONSES_ITEM.INPUT_TEXT)
        : [];
      if (parts.length > 0) {
        out.push({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: parts });
      }
      continue;
    }
    if ((item.type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT
        || item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) && !item.call_id) {
      const parts = Array.isArray(item.output)
        ? item.output.filter((c) => c?.type === RESPONSES_ITEM.INPUT_TEXT || c?.type === RESPONSES_ITEM.INPUT_IMAGE)
        : (typeof item.output === "string" && item.output !== ""
            ? [{ type: RESPONSES_ITEM.INPUT_TEXT, text: item.output }]
            : []);
      if (parts.length > 0) {
        out.push({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: parts });
      }
      continue;
    }
    if (item.type === RESPONSES_ITEM.REASONING
      && typeof item.encrypted_content === "string"
      && item.encrypted_content.startsWith(FERNET_ENCRYPTED_CONTENT_PREFIX)
      && !reasoningHasReadableText(item)) {
      continue;
    }
    out.push(item);
  }
  return out;
}

// Fallback ids share one Date.now() when a batch of items is sanitized in a tight
// loop — a per-process sequence keeps same-millisecond ids unique so
// function_call ↔ function_call_output correlation never collides.
let responsesCallIdSeq = 0;

export function clampResponsesCallId(id) {
  if (typeof id !== "string" || !id) return `call_${Date.now()}_${(responsesCallIdSeq += 1)}`;
  return id.length > MAX_RESPONSES_CALL_ID_LEN ? id.substring(0, MAX_RESPONSES_CALL_ID_LEN) : id;
}

// Single-stringify: objects → JSON once; valid JSON strings pass through untouched;
// anything else (partial fragments, empty) falls back to "{}" instead of
// double-encoding and tripping upstream InputValidationError.
export function coerceResponsesArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  try {
    JSON.parse(value);
    return value;
  } catch {
    return "{}";
  }
}

// function_call_output.output must be a string — never null/object.
export function coerceResponsesOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((c) => {
      try {
        return c?.text ?? JSON.stringify(c);
      } catch {
        return String(c);
      }
    }).join("");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert OpenAI Responses API format to standard chat completions format
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
export function convertResponsesApiFormat(body) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolCalls = [];
  let pendingToolResults = [];

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  for (const rawItem of inputItems) {
    const item = normalizeResponsesAgentMessage(rawItem);
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      result.messages.push({ role: item.role, content });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
      }
      // Skip items with empty/missing name — upstream APIs reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Add tool result
      pendingToolResults.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Skip reasoning items - they are for display only
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Cleanup Responses API specific fields
  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}
