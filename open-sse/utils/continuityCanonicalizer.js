import crypto from "crypto";
import { FORMATS } from "../translator/formats.js";

// Process-local secret, created once on process start.
const processContinuitySecret = crypto.randomBytes(32);

/**
 * Derive continuity scope ID using HMAC of the apiKey.
 * Raw API key is never stored, logged, or included directly in hashes.
 */
export function deriveContinuityScopeId(apiKey) {
  if (typeof apiKey !== "string" || !apiKey) return null;
  return crypto.createHmac("sha256", processContinuitySecret)
    .update(apiKey)
    .digest("hex");
}

/**
 * Normalizes string line endings CRLF/CR -> LF.
 */
export function normalizeText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\r\n|\r/g, "\n");
}

/**
 * Deterministic JSON stringify helper for stable digests.
 */
export function stableJson(value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map(stableJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(k => {
      const val = stableJson(value[k]);
      return val !== "" ? JSON.stringify(k) + ":" + val : "";
    }).filter(Boolean);
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Normalizes tool arguments to a stable format.
 */
function canonicalizeToolArgs(args) {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return stableJson(parsed);
    } catch {
      return args;
    }
  }
  if (args && typeof args === "object") {
    return stableJson(args);
  }
  return "";
}

function makeRawToolCall(name, args, rawLink) {
  return {
    name: name || "",
    arguments: canonicalizeToolArgs(args),
    rawLink: rawLink || ""
  };
}

function makeRawToolResult(rawLink, nameHint, content) {
  return {
    rawLink: rawLink || "",
    nameHint: nameHint || "",
    content: normalizeText(content || "")
  };
}

/**
 * Extracts text content from a tool_result content field, which per the Claude
 * schema can be either a plain string or an array of content blocks (text/image).
 */
function canonicalizeToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p?.type === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("");
  }
  return "";
}

/**
 * Extract a stable descriptor for attachments.
 */
function canonicalizeAttachment(att) {
  if (!att || typeof att !== "object") return "";
  const source = att.source && typeof att.source === "object" ? att.source : null;
  const type = att.type || source?.type || "";
  const mime = att.mime || att.mime_type || att.mimeType || att.media_type || source?.mime || source?.mime_type || source?.mimeType || source?.media_type || "";
  const reference = att.url || att.fileUri || att.file_uri || att.image_url?.url || source?.url || source?.fileUri || source?.file_uri || "";
  const data = att.data || att.inlineData?.data || source?.data || "";
  const contentDigest = !reference && typeof data === "string" && data
    ? crypto.createHash("sha256").update(data).digest("hex")
    : "";
  return stableJson({ type, mime, reference, contentDigest });
}

function getGeminiHistoryBody(body, sourceFormat) {
  if (sourceFormat === FORMATS.ANTIGRAVITY && Array.isArray(body?.request?.contents)) {
    return body.request;
  }
  return body;
}

function canonicalizeGeminiSystemInstruction(systemInstruction) {
  if (typeof systemInstruction === "string") return normalizeText(systemInstruction);
  if (!systemInstruction || typeof systemInstruction !== "object") return "";
  if (typeof systemInstruction.text === "string") return normalizeText(systemInstruction.text);

  const parts = Array.isArray(systemInstruction.parts)
    ? systemInstruction.parts
    : (Array.isArray(systemInstruction.content?.parts) ? systemInstruction.content.parts : []);
  return normalizeText(parts
    .filter(part => typeof part?.text === "string" && part.thought !== true)
    .map(part => part.text)
    .join(""));
}

/**
 * Extracts text from Claude's top-level `system` field, which per the schema
 * can be either a plain string or an array of {type:"text", text} blocks.
 */
function canonicalizeClaudeSystemField(system) {
  if (typeof system === "string") return normalizeText(system);
  if (!Array.isArray(system)) return "";
  return normalizeText(system
    .filter(block => block && typeof block.text === "string")
    .map(block => block.text)
    .join(""));
}

/**
 * Main function to canonicalize any incoming request body history.
 */
export function canonicalizeIncomingHistory(body, sourceFormat) {
  if (!body) return [];
  const events = [];
  const geminiBody = getGeminiHistoryBody(body, sourceFormat);

  if (sourceFormat === FORMATS.OPENAI_RESPONSES || Array.isArray(body.input) || typeof body.input === "string") {
    // Responses API carries the system/developer prompt in a separate top-level
    // `instructions` string, not inside `input[]` — must anchor as a leading
    // event or it never participates in pair identity at all.
    const instructions = typeof body.instructions === "string" ? normalizeText(body.instructions) : "";
    if (instructions) {
      events.push({ role: "system", kind: "text", payload: instructions });
    }
    // OpenAI Responses-API — `input` may be a bare string (single user turn),
    // not only an item array; dropping it would leave the first turn of every
    // string-input dialog outside pair identity.
    if (typeof body.input === "string") {
      if (body.input) {
        events.push({ role: "user", kind: "text", payload: normalizeText(body.input) });
      }
      return events;
    }
    const input = Array.isArray(body.input) ? body.input : [];
    for (const item of input) {
      if (!item) continue;
      // Message items may arrive as {type:"message"} or as bare {role, content}
      // (the type field is optional on input items in the Responses schema).
      if (item.role && (item.type === "message" || !item.type)) {
        const textParts = [];
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            // Responses content blocks are typed input_text/output_text, not "text".
            if ((c?.type === "text" || c?.type === "input_text" || c?.type === "output_text") && typeof c.text === "string") {
              textParts.push(normalizeText(c.text));
            }
          }
        } else if (typeof item.content === "string") {
          textParts.push(normalizeText(item.content));
        }
        events.push({
          role: item.role,
          kind: "text",
          payload: textParts.join("")
        });
      } else if (item.type === "function_call") {
        events.push({
          role: "assistant",
          kind: "tool_call",
          // Responses API correlates function_call <-> function_call_output by
          // call_id, not the item's own id (see translator/request/openai-responses.js) —
          // reading item.id here means these events could never fingerprint-link to
          // their matching output.
          payload: makeRawToolCall(item.name, item.arguments, item.call_id || item.id)
        });
      } else if (item.type === "function_call_output") {
        events.push({
          role: "tool",
          kind: "tool_result",
          payload: makeRawToolResult(item.call_id || item.id, "", item.output)
        });
      }
    }
  } else if (Array.isArray(body.messages)) {
    // Claude's system prompt is a separate top-level field, not a messages[] entry —
    // must anchor as a leading event or it never participates in pair identity.
    const claudeSystem = canonicalizeClaudeSystemField(body.system);
    if (claudeSystem) {
      events.push({ role: "system", kind: "text", payload: claudeSystem });
    }
    // Standard OpenAI or Anthropic / Ollama
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role || "";

      // Handle tool results
      if (role === "tool" || role === "tool_result") {
        let content = "";
        if (typeof msg.content === "string") {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          const parts = [];
          for (const part of msg.content) {
            if (part?.type === "text" && typeof part.text === "string") {
              parts.push(part.text);
            } else if (part?.type === "tool_result" && typeof part.content === "string") {
              parts.push(part.content);
            }
          }
          content = parts.join("");
        }
        events.push({
          role: "tool",
          kind: "tool_result",
          payload: makeRawToolResult(msg.tool_call_id || msg.tool_use_id, "", content)
        });
        continue;
      }

      // Handle messages with content blocks in their real event order. Claude can
      // interleave text/tool_use/text, and buffering all text ahead of tool calls
      // makes the replayed request fingerprint differ from the committed output.
      const eventCountBefore = events.length;
      let textContent = "";
      const flushText = () => {
        if (textContent) {
          events.push({
            role,
            kind: "text",
            payload: normalizeText(textContent)
          });
          textContent = "";
        }
      };

      if (typeof msg.content === "string") {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === "text" && typeof part.text === "string") {
            textContent += part.text;
          } else if ((part.type === "thinking" || part.type === "redacted_thinking") && typeof part.thinking === "string") {
            flushText();
            events.push({ role, kind: "text", payload: normalizeText(part.thinking) });
          } else if (part.type === "tool_use" || part.type === "tool_call") {
            flushText();
            events.push({
              role,
              kind: "tool_call",
              payload: makeRawToolCall(part.name, part.input || part.arguments, part.id)
            });
          } else if (part.type === "tool_result") {
            flushText();
            // Claude tool results arrive inline inside a role:"user" message's content
            // array (not as a top-level role:"tool" message like OpenAI) — without this
            // branch the result is silently dropped from canonical history and never
            // participates in pair identity.
            events.push({
              role: "tool",
              kind: "tool_result",
              payload: makeRawToolResult(part.tool_use_id, "", canonicalizeToolResultContent(part.content))
            });
          } else if (part.type === "image" || part.type === "image_url") {
            flushText();
            events.push({
              role,
              kind: "attachment",
              payload: canonicalizeAttachment(part)
            });
          }
        }
        flushText();
      }

      flushText();

      // Check for top-level tool_calls (OpenAI format)
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.function) {
            events.push({
              role,
              kind: "tool_call",
              payload: makeRawToolCall(tc.function.name, tc.function.arguments, tc.id)
            });
          }
        }
      }

      // An assistant turn that produced no text/tool-call/attachment event (e.g. a
      // reasoning-only turn that spent its whole budget on thinking) must still anchor
      // a pair boundary, or the preceding thoughts can never be fingerprinted/replayed.
      if (role === "assistant" && events.length === eventCountBefore) {
        events.push({ role: "assistant", kind: "empty_output", payload: "" });
      }
    }
  } else if (Array.isArray(geminiBody.contents)) {
    // Gemini format (contents:[{role, parts:[{text...}]}])
    const systemInstruction = canonicalizeGeminiSystemInstruction(geminiBody.systemInstruction);
    if (systemInstruction) {
      events.push({ role: "system", kind: "text", payload: systemInstruction });
    }
    for (const content of geminiBody.contents) {
      if (!content || typeof content !== "object") continue;
      const role = content.role === "model" ? "assistant" : "user";
      const eventCountBefore = events.length;
      if (Array.isArray(content.parts)) {
        // Adjacent text parts coalesce into one run, closed by any non-text part —
        // must mirror canonicalizeClientOutput's candidates[] walk exactly, or a
        // multi-text-part model turn replayed by the client fingerprints differently
        // than the turn we committed.
        let text = "";
        const flushText = () => {
          if (text) events.push({ role, kind: "text", payload: normalizeText(text) });
          text = "";
        };
        for (const part of content.parts) {
          if (!part) continue;
          if (part.text && !part.thought) {
            text += part.text;
          } else if (part.functionCall) {
            flushText();
            events.push({
              role,
              kind: "tool_call",
              payload: makeRawToolCall(part.functionCall.name, part.functionCall.args, part.functionCall.id)
            });
          } else if (part.functionResponse) {
            flushText();
            events.push({
              role: "tool",
              kind: "tool_result",
              payload: makeRawToolResult("", part.functionResponse.name, stableJson(part.functionResponse.response))
            });
          } else if (part.inlineData || part.fileData) {
            flushText();
            events.push({
              role,
              kind: "attachment",
              payload: canonicalizeAttachment(part.inlineData || part.fileData)
            });
          }
        }
        flushText();
      }
      if (role === "assistant" && events.length === eventCountBefore) {
        events.push({ role: "assistant", kind: "empty_output", payload: "" });
      }
    }
  }

  return events;
}

/**
 * Canonicalize final client-facing output format into events.
 */
export function canonicalizeClientOutput(responseOrEvents, sourceFormat) {
  if (!responseOrEvents) return [];
  if (Array.isArray(responseOrEvents)) {
    // Already in event format or array of chunks
    return responseOrEvents;
  }

  const events = [];
  const obj = responseOrEvents;
  let recognizedShape = false;

  // Responses format
  if (Array.isArray(obj.output)) {
    recognizedShape = true;
    for (const item of obj.output) {
      if (!item) continue;
      if (item.type === "message" && item.role === "assistant") {
        const text = Array.isArray(item.content)
          ? item.content.map(c => c?.text || "").join("")
          : (typeof item.content === "string" ? item.content : "");
        if (text) {
          events.push({
            role: "assistant",
            kind: "text",
            payload: normalizeText(text)
          });
        }
      } else if (item.type === "function_call") {
        events.push({
          role: "assistant",
          kind: "tool_call",
          // Same correlation rule as incoming: Responses pairs function_call with
          // function_call_output via call_id — using item.id here would make the
          // committed output fingerprint never match the client's replayed history.
          payload: makeRawToolCall(item.name, item.arguments, item.call_id || item.id)
        });
      }
    }
    return finalizeClientOutputEvents(events, recognizedShape);
  }

  // Standard OpenAI Choice-based
  if (Array.isArray(obj.choices)) {
    recognizedShape = true;
    for (const choice of obj.choices) {
      const msg = choice?.message;
      if (!msg) continue;

      let text = "";
      const flushText = () => {
        if (text) {
          events.push({
            role: "assistant",
            kind: "text",
            payload: normalizeText(text)
          });
          text = "";
        }
      };
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (typeof part.text === "string") {
            text += part.text;
          } else if (part.type === "image" || part.type === "image_url") {
            flushText();
            events.push({
              role: "assistant",
              kind: "attachment",
              payload: canonicalizeAttachment(part)
            });
          }
        }
      }
      flushText();

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.function) {
            events.push({
              role: "assistant",
              kind: "tool_call",
              payload: makeRawToolCall(tc.function.name, tc.function.arguments, tc.id)
            });
          }
        }
      }
    }
    return finalizeClientOutputEvents(events, recognizedShape);
  }

  // Claude Format choice / content block
  if (Array.isArray(obj.content)) {
    recognizedShape = true;
    let text = "";
    const flushText = () => {
      if (text) {
        events.push({
          role: "assistant",
          kind: "text",
          payload: normalizeText(text)
        });
        text = "";
      }
    };
    for (const part of obj.content) {
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
      } else if (part.type === "tool_use") {
        flushText();
        events.push({
          role: "assistant",
          kind: "tool_call",
          payload: makeRawToolCall(part.name, part.input, part.id)
        });
      } else if (part.type === "image" || part.type === "image_url") {
        flushText();
        events.push({
          role: "assistant",
          kind: "attachment",
          payload: canonicalizeAttachment(part)
        });
      }
    }
    flushText();
    return finalizeClientOutputEvents(events, recognizedShape);
  }

  // Gemini / Antigravity / Vertex (wrapped `{ response: { candidates } }` or bare `{ candidates }`)
  const geminiResponse = obj.response?.candidates ? obj.response : (obj.candidates ? obj : null);
  if (geminiResponse?.candidates) {
    recognizedShape = true;
    for (const candidate of geminiResponse.candidates) {
      const parts = candidate?.content?.parts;
      if (!Array.isArray(parts)) continue;
      // Emit per-part events in stream order (text run closed by any functionCall),
      // exactly mirroring canonicalizeIncomingHistory's contents[] walk — buffering
      // all text first would break the fingerprint for interleaved turns.
      let text = "";
      const flushText = () => {
        if (text) events.push({ role: "assistant", kind: "text", payload: normalizeText(text) });
        text = "";
      };
      for (const part of parts) {
        if (!part) continue;
        if (typeof part.text === "string" && !part.thought) {
          text += part.text;
        } else if (part.functionCall) {
          flushText();
          events.push({
            role: "assistant",
            kind: "tool_call",
            payload: makeRawToolCall(part.functionCall.name, part.functionCall.args, part.functionCall.id)
          });
        } else if (part.inlineData || part.fileData) {
          flushText();
          events.push({
            role: "assistant",
            kind: "attachment",
            payload: canonicalizeAttachment(part.inlineData || part.fileData)
          });
        }
      }
      flushText();
    }
    return finalizeClientOutputEvents(events, recognizedShape);
  }

  // Ollama native message shape
  if (obj.message && typeof obj.message === "object") {
    recognizedShape = true;
    if (typeof obj.message.content === "string" && obj.message.content) {
      events.push({ role: "assistant", kind: "text", payload: normalizeText(obj.message.content) });
    }
    // Ollama tool calls: message.tool_calls[].function — no id in the native schema,
    // which matches the incoming side (messages[].tool_calls with no id) so the pair
    // fingerprint still round-trips.
    if (Array.isArray(obj.message.tool_calls)) {
      for (const tc of obj.message.tool_calls) {
        if (!tc?.function) continue;
        events.push({
          role: "assistant",
          kind: "tool_call",
          payload: makeRawToolCall(tc.function.name, tc.function.arguments, tc.id)
        });
      }
    }
    return finalizeClientOutputEvents(events, recognizedShape);
  }

  return events;
}

/**
 * A recognized client-facing response shape that produced zero text/tool-call/attachment events
 * (e.g. a reasoning-only turn that spent its whole budget on thinking, so the visible
 * message/content array came back empty) must still anchor a pair boundary — otherwise
 * this turn's thoughts can never be fingerprinted and continuity for it is silently lost.
 */
function finalizeClientOutputEvents(events, recognizedShape) {
  if (recognizedShape && events.length === 0) {
    return [{ role: "assistant", kind: "empty_output", payload: "" }];
  }
  return events;
}

/**
 * Incrementally accumulates streaming client-facing chunks (already translated
 * or passed through, i.e. exactly what is emitted on the wire) into canonical
 * output events at flush time. Duck-types by shape so a single accumulator
 * instance covers translate-mode and passthrough-mode streaming alike, and
 * never needs to re-parse serialized SSE bytes.
 *
 * Events are kept in the actual order the client received them: text and
 * tool-call segments are tracked as an ordered sequence, not merged into one
 * global string + a trailing tool-call list, so a real interleaving (text,
 * tool_call, text) round-trips into the same shape the next incoming request's
 * canonicalizer will see — otherwise the pair fingerprint after a stream turn
 * would never match the fingerprint of the same turn replayed by the client.
 */
export function createClientOutputAccumulator() {
  const segments = new Map(); // key -> { type: "text"|"tool_call"|"attachment", text|id/name/args|payload }
  const order = [];
  let completeSeq = 0;
  // Tracks the currently-appendable un-indexed text run (OpenAI chat.completions
  // `delta.content`, Responses `response.output_text.delta`). Any tool-call segment
  // in between closes it, so the next text delta opens a new run instead of merging.
  let activeTextKey = null;

  function textSegment(key) {
    if (!segments.has(key)) { segments.set(key, { type: "text", text: "" }); order.push(key); }
    return segments.get(key);
  }

  function toolSegment(key) {
    if (!segments.has(key)) { segments.set(key, { type: "tool_call", id: "", name: "", args: "" }); order.push(key); }
    return segments.get(key);
  }

  function attachmentSegment(key) {
    if (!segments.has(key)) { segments.set(key, { type: "attachment", payload: "" }); order.push(key); }
    return segments.get(key);
  }

  function appendActiveText(str) {
    if (!str) return;
    if (!activeTextKey) activeTextKey = `text-${order.length}`;
    textSegment(activeTextKey).text += str;
  }

  function closeActiveText() {
    activeTextKey = null;
  }

  function pushComplete(name, args, id) {
    const seg = toolSegment(`complete-${completeSeq++}`);
    seg.id = id || ""; seg.name = name || ""; seg.args = args || "";
    closeActiveText();
  }

  function pushCompleteAttachment(att) {
    const seg = attachmentSegment(`attachment-${completeSeq++}`);
    seg.payload = canonicalizeAttachment(att);
    closeActiveText();
  }

  function pushStructuredContentParts(parts) {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!part) continue;
      if (typeof part.text === "string") {
        appendActiveText(part.text);
      } else if (part.type === "image" || part.type === "image_url") {
        pushCompleteAttachment(part);
      }
    }
  }

  function push(item) {
    if (!item || typeof item !== "object") return;

    // OpenAI chat.completions delta
    const delta0 = item.choices?.[0]?.delta;
    if (delta0) {
      if (typeof delta0.content === "string" && delta0.content) appendActiveText(delta0.content);
      if (Array.isArray(delta0.tool_calls)) {
        for (const tc of delta0.tool_calls) {
          const entry = toolSegment(`idx-${tc.index ?? 0}`);
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          closeActiveText();
        }
      }
      pushStructuredContentParts(delta0.content);
    }

    // Claude content blocks: explicit index-based ordering — start events arrive
    // in stream order, so keying segments by block index preserves interleaving.
    if (item.type === "content_block_start") {
      const key = `idx-${item.index}`;
      if (item.content_block?.type === "tool_use") {
        const entry = toolSegment(key);
        entry.id = item.content_block.id || entry.id;
        entry.name = item.content_block.name || entry.name;
      } else if (item.content_block?.type === "text") {
        textSegment(key);
      } else if (item.content_block?.type === "image") {
        const entry = attachmentSegment(key);
        entry.payload = canonicalizeAttachment(item.content_block);
        closeActiveText();
      }
    }
    if (item.type === "content_block_delta") {
      const key = `idx-${item.index}`;
      if (typeof item.delta?.text === "string") textSegment(key).text += item.delta.text;
      if (typeof item.delta?.thinking === "string") textSegment(key).text += item.delta.thinking;
      if (item.delta?.type === "input_json_delta" && typeof item.delta.partial_json === "string") {
        toolSegment(key).args += item.delta.partial_json;
      }
    }

    // Gemini / Antigravity: function calls arrive as one complete part, not deltas
    const parts = item.candidates?.[0]?.content?.parts || item.response?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part) continue;
        if (typeof part.text === "string" && !part.thought) appendActiveText(part.text);
        if (part.functionCall) pushComplete(part.functionCall.name, part.functionCall.args, part.functionCall.id);
        if (part.inlineData || part.fileData) pushCompleteAttachment(part.inlineData || part.fileData);
      }
    }

    // Ollama — streamed tool calls arrive complete (not as deltas)
    if (typeof item.message?.content === "string" && item.message.content) appendActiveText(item.message.content);
    if (Array.isArray(item.message?.tool_calls)) {
      for (const tc of item.message.tool_calls) {
        if (tc?.function) pushComplete(tc.function.name, tc.function.arguments, tc.id);
      }
    }

    // CommandCode (AI SDK v5)
    if (item.type === "text-delta" && typeof item.text === "string") appendActiveText(item.text);

    // OpenAI Responses API
    if (item.type === "response.output_text.delta" && typeof item.delta === "string") appendActiveText(item.delta);
    if (item.type === "response.output_item.done" && item.item?.type === "function_call") {
      pushComplete(item.item.name, item.item.arguments, item.item.call_id || item.item.id);
    }
  }

  function finalize() {
    const events = [];
    for (const key of order) {
      const seg = segments.get(key);
      if (!seg) continue;
      if (seg.type === "text") {
        const trimmed = normalizeText(seg.text);
        if (trimmed) events.push({ role: "assistant", kind: "text", payload: trimmed });
      } else if (seg.type === "tool_call") {
        events.push({
          role: "assistant",
          kind: "tool_call",
          payload: makeRawToolCall(seg.name, seg.args, seg.id)
        });
      } else if (seg.payload) {
        events.push({ role: "assistant", kind: "attachment", payload: seg.payload });
      }
    }
    // A reasoning-only streamed turn (no visible text, no tool call) must still
    // anchor a pair boundary — see finalizeClientOutputEvents above for the
    // non-streaming equivalent of this rule.
    if (events.length === 0) events.push({ role: "assistant", kind: "empty_output", payload: "" });
    return events;
  }

  return { push, finalize };
}

/**
 * Privacy-safe diagnostic summary of a canonical event sequence: `role:kind`
 * pairs only, never the payload (prompt text, thinking, tool args, attachment
 * data, or API key). Used exclusively for continuity trace logging so a
 * fingerprint-mismatch investigation can compare event *shape* across a
 * commit/lookup boundary without ever emitting content into logs.
 */
export function describeEventShape(events) {
  if (!Array.isArray(events)) return "";
  return events.map(e => `${e.role}:${e.kind}`).join(",");
}

/**
 * True when `e` is part of a model/assistant visible output turn (text,
 * tool call, attachment, or an anchored empty turn) — the boundary
 * `splitCompletedPairs` groups consecutive runs of into one pair's
 * `output`, and the same boundary `normalizeToolLinkage` uses to know when
 * a fresh tool-call batch starts. Hoisted to module scope and shared by
 * both so they can never disagree about where a turn begins or ends.
 */
function isAssistantOutputEvent(e) {
  return e.role === "assistant" && (e.kind === "text" || e.kind === "tool_call" || e.kind === "attachment" || e.kind === "empty_output");
}

/**
 * Rewrites raw tool transport linkage (`rawLink`, legacy `id`) into semantic
 * normalized payloads before hashing. Tool calls keep only `{slot, name,
 * arguments}`. Linked tool results copy that call descriptor plus `content`.
 * Unlinked results become `{unlinked:true, content}` and are treated as
 * ineligible for continuity matching/commit when they are the newest completed
 * turn's input.
 */
export function normalizeToolLinkage(events) {
  if (!Array.isArray(events)) return [];
  const rawLinkToDescriptor = new Map();
  let inRun = false;
  let batch = -1;
  let batchSlotCounter = 0;
  let lastBatchDescriptors = [];

  const normalizeCall = (payload = {}) => {
    const rawLink = payload.rawLink || payload.id || "";
    const descriptor = {
      slot: `slot:${batchSlotCounter++}`,
      name: payload.name || "",
      arguments: canonicalizeToolArgs(payload.arguments),
      batch,
      pending: true,
      rawLink
    };
    if (rawLink) rawLinkToDescriptor.set(rawLink, descriptor);
    lastBatchDescriptors.push(descriptor);
    return descriptor;
  };

  const findByNameHint = (nameHint) => {
    if (!nameHint) return null;
    const matches = lastBatchDescriptors.filter(d => d.pending && d.name === nameHint);
    return matches.length === 1 ? matches[0] : null;
  };

  const normalizeResult = (payload = {}) => {
    const rawLink = payload.rawLink || payload.id || "";
    const rawDescriptor = rawLink ? rawLinkToDescriptor.get(rawLink) : null;
    const descriptor = (rawDescriptor?.pending ? rawDescriptor : null) || findByNameHint(payload.nameHint || "");
    if (!descriptor) {
      return {
        unlinked: true,
        content: normalizeText(payload.content || "")
      };
    }
    if (descriptor.rawLink) rawLinkToDescriptor.delete(descriptor.rawLink);
    descriptor.pending = false;
    return {
      slot: descriptor.slot,
      name: descriptor.name,
      arguments: descriptor.arguments,
      content: normalizeText(payload.content || "")
    };
  };

  return events.map(ev => {
    if (!isAssistantOutputEvent(ev)) {
      inRun = false;
      if (ev.role === "tool" && ev.kind === "tool_result") {
        return { ...ev, payload: normalizeResult(ev.payload) };
      }
      return ev;
    }

    if (!inRun) {
      inRun = true;
      batch += 1;
      batchSlotCounter = 0;
      lastBatchDescriptors = [];
    }
    if (ev.kind !== "tool_call") return ev;

    const descriptor = normalizeCall(ev.payload);
    return {
      ...ev,
      payload: {
        slot: descriptor.slot,
        name: descriptor.name,
        arguments: descriptor.arguments
      }
    };
  });
}

function hasUnlinkedToolResult(events) {
  return Array.isArray(events) && events.some(ev => ev.role === "tool" && ev.kind === "tool_result" && ev.payload?.unlinked === true);
}

function splitContinuityHistory(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { records: [], trailingInput: [], normalizedEvents: [] };
  }
  // Normalize tool_call/tool_result transport ids to semantic linkage before
  // anything else — see normalizeToolLinkage for why. Must run on the full
  // event stream (not per-pair) because a tool_result's matching tool_call
  // lives in the PREVIOUS pair's output.
  events = normalizeToolLinkage(events);
  const records = [];

  let leadIdx = 0;
  while (leadIdx < events.length && (events[leadIdx].role === "system" || events[leadIdx].role === "developer")) {
    leadIdx += 1;
  }
  const ignoredContext = events.slice(0, leadIdx);
  const remainingEvents = events.slice(leadIdx);

  let currentInput = [];
  let i = 0;

  while (i < remainingEvents.length) {
    const ev = remainingEvents[i];
    if (isAssistantOutputEvent(ev)) {
      const outputs = [ev];
      let j = i + 1;
      while (j < remainingEvents.length) {
        const nextEv = remainingEvents[j];
        if (isAssistantOutputEvent(nextEv)) {
          outputs.push(nextEv);
          j++;
        } else {
          break;
        }
      }
      i = j - 1;

      records.push({ ignoredContext, input: currentInput, output: outputs });
      currentInput = [];
    } else {
      currentInput.push(ev);
    }
    i++;
  }

  return { records, trailingInput: currentInput, normalizedEvents: events };
}

function hashPairRecord({ input, output }, scopeId) {
  const fingerprintObj = {
    version: "continuity-pair-v1",
    scopeId,
    input,
    output
  };
  return crypto.createHmac("sha256", processContinuitySecret)
    .update(stableJson(fingerprintObj))
    .digest("hex");
}

export function analyzeContinuityHistory(events, scopeId) {
  const { records, trailingInput, normalizedEvents } = splitContinuityHistory(events);
  const hasTrailingBarrier = hasUnlinkedToolResult(trailingInput);
  let lastBarrierIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    if (hasUnlinkedToolResult(records[i].input)) lastBarrierIndex = i;
  }
  const postBarrierRecords = hasTrailingBarrier ? [] : records.slice(lastBarrierIndex + 1);
  const pairHashes = scopeId ? postBarrierRecords.map(record => hashPairRecord(record, scopeId)) : [];
  const canResolve = Boolean(scopeId && !hasTrailingBarrier && pairHashes.length > 0);
  const canCommit = Boolean(canResolve && records.length > 0 && lastBarrierIndex !== records.length - 1);
  return {
    records,
    trailingInput,
    normalizedEvents,
    hasTrailingBarrier,
    lastBarrierIndex,
    postBarrierRecords,
    pairHashes,
    canResolve,
    canCommit
  };
}

/**
 * Split logical events into request-response completed pair *records* —
 * { ignoredContext, input, output } — without hashing anything. This is
 * the single shared split walk: `buildCompletedPairs` folds each record's
 * input/output into a scoped HMAC fingerprint, and `describeLastCompletedPair`
 * (diagnostics only) walks the exact same records to trace per-event
 * shape+digest without ever computing or logging the real scoped pair hash.
 * Keeping one function as the source of the split guarantees the two can
 * never drift apart.
 */
export function splitCompletedPairs(events) {
  // A leading system/developer instruction precedes the first real turn, not
  // just the first pair, so it must never be left glued onto whichever pair
  // happens to sit first in the (possibly truncated) history — otherwise a
  // pair from turn N stops matching itself once the client truncates turns
  // 1..N-1 and that pair becomes the new first pair. Splitting it out keeps
  // every pair's `input` limited to the actual user/tool turn regardless of
  // where it sits in the history.
  //
  // ignoredContext is deliberately NOT folded into the fingerprint (see
  // buildCompletedPairs below) even though it used to be: production tracing
  // (describeLastCompletedPair on a live Antigravity dialog) proved this
  // content is rebuilt by the client/proxy between requests INSIDE the same
  // dialog — same visible user input, same assistant output, different
  // systemInstruction — which made every pair after the first miss its prior
  // state. Dialog identity is the client's visible input/output only; leading
  // system/developer/instructions/systemInstruction content is still split
  // out here (so it can never corrupt a pair's `input`) and is still sent to
  // the model as before — it just no longer participates in continuity
  // identity. It is kept on the record (renamed) solely so
  // describeLastCompletedPair can surface it for diagnostics without a
  // second, drift-prone split implementation.
  return splitContinuityHistory(events).records;
}

/**
 * Split logical events into request-response completed pairs.
 * Each completed pair represents:
 *   [input canonical events] -> [output canonical events]
 */
export function buildCompletedPairs(events, scopeId) {
  if (!scopeId) return [];
  // Dialog identity is exclusively the client-visible input and assistant
  // output of each post-barrier pair. Leading system/developer/instructions/
  // systemInstruction content (splitCompletedPairs' ignoredContext) is
  // deliberately excluded — it is ambient request configuration, not part
  // of what makes this the "same" pair, and real clients/proxies (observed:
  // Antigravity) can rebuild it turn-to-turn without the dialog itself
  // changing. A prior revision folded it in to survive history truncation;
  // that truncation case is still handled structurally by splitCompletedPairs
  // routing it into ignoredContext instead of a pair's `input`, so dropping
  // it from the hash here does not reintroduce the truncation bug.
  return analyzeContinuityHistory(events, scopeId).pairHashes;
}

/**
 * Privacy-safe payload summary for a canonical event — shows field *shapes*
 * (char counts, tool names, slot indices, link status) so two traces can be
 * diffed to find WHICH field changed, without ever printing the field's raw
 * content (no prompt text, no tool args, no tool result content, no transport
 * IDs). This is the human-readable complement to the HMAC digest below.
 */
function traceEventSummary(event) {
  const p = event.payload;
  if (!p || typeof p !== "object") {
    if (typeof p === "string") return `text:${p.length}c`;
    return "empty";
  }
  switch (event.kind) {
    case "text":
      return `text:${typeof p === "string" ? p.length : 0}c`;
    case "tool_call":
      // Post-normalization: { slot, name, arguments }
      // Pre-normalization: { name, arguments, rawLink }
      if (typeof p.slot === "string") {
        return `tool:${p.name || "?"},${typeof p.arguments === "string" ? p.arguments.length : 0}c,${p.slot}`;
      }
      return `tool:${p.name || "?"},${typeof p.arguments === "string" ? p.arguments.length : 0}c,link:${p.rawLink ? "Y" : "N"}`;
    case "tool_result":
      // Linked: { slot, name, arguments, content }
      // Unlinked: { unlinked: true, content }
      if (p.unlinked === true) {
        return `result:unlinked,${typeof p.content === "string" ? p.content.length : 0}c`;
      }
      return `result:${p.slot || "?"},${p.name || "?"},${typeof p.content === "string" ? p.content.length : 0}c`;
    case "attachment":
      // payload is a stableJson string from canonicalizeAttachment
      if (typeof p === "string") {
        // Extract type and mime from the stable JSON for a compact summary
        const typeMatch = p.match(/"type":"([^"]*)"/);
        const mimeMatch = p.match(/"mime":"([^"]*)"/);
        return `attach:${typeMatch?.[1] || "?"}:${mimeMatch?.[1] || "?"}`;
      }
      return "attach:?";
    case "empty_output":
      return "empty";
    default:
      return "?";
  }
}

/**
 * Privacy-safe per-event diagnostic digest: `role:kind#<10-hex>(<summary>)`
 * where the digest is an HMAC over {role, kind, payload} only — never scopeId
 * or sibling events. The summary is a short shape descriptor (char counts,
 * tool names, slot indices) that lets two traces be diffed to find which
 * specific field changed without ever printing prompt/thinking/tool-arg
 * content. Deliberately NOT the real pair fingerprint (which also folds in
 * scopeId + full pair grouping) — this exists purely so a commit and a later
 * lookup can diff *which specific event* changed.
 */
function traceEventDigest(event) {
  const digest = crypto.createHmac("sha256", processContinuitySecret)
    .update(stableJson({ role: event.role, kind: event.kind, payload: event.payload }))
    .digest("hex")
    .slice(0, 10);
  const summary = traceEventSummary(event);
  return `${event.role}:${event.kind}#${digest}(${summary})`;
}

/**
 * Diagnostic-only trace of the last completed pair's ignoredContext/input/output,
 * each event reduced to `role:kind#digest` via traceEventDigest. Uses the
 * exact same split as buildCompletedPairs (via splitCompletedPairs) so this
 * can never disagree with what was actually fingerprinted. Labeled
 * `ignoredContext` (not `context`) so a divergence there is never mistaken
 * for an identity cause during an incident — it plays no part in the
 * fingerprint. Never logs the real scoped pair hash or any payload content —
 * only used to localize a fingerprint mismatch to a specific event slot
 * across a commit/lookup boundary.
 */
export function describeLastCompletedPair(events) {
  const records = splitCompletedPairs(events);
  if (records.length === 0) return "none";
  const { ignoredContext, input, output } = records[records.length - 1];
  const ctx = ignoredContext.map(traceEventDigest).join(",");
  const inp = input.map(traceEventDigest).join(",");
  const out = output.map(traceEventDigest).join(",");
  return `ignoredContext=[${ctx}] input=[${inp}] output=[${out}]`;
}

/**
 * Truncates pairs chronologically to a max window.
 */
export function buildPairWindow(pairHashes, maxWindow = 10) {
  if (!Array.isArray(pairHashes)) return [];
  return pairHashes.slice(-maxWindow);
}

/**
 * Diagnostic-only trace of ALL canonical events in order, each reduced to
 * `role:kind#digest(summary)` via traceEventDigest. This is the full incoming
 * or outgoing event stream — so a debug investigation can see exactly which
 * events the canonicalizer produced from the client's raw request body (or
 * from the response), and diff them turn-to-turn to find what the client or
 * a translation hop changed. Never logs raw payload content.
 *
 * Returns a single-line string: `events=N [0]digest [1]digest ...`
 */
export function describeAllEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return "events=0";
  const parts = events.map((e, i) => `[${i}]${traceEventDigest(e)}`);
  return `events=${events.length} ${parts.join(" ")}`;
}

/**
 * Diagnostic-only trace of ALL completed pairs with their real scoped pair
 * hashes (10-char prefix) and per-event digests. This is the full pair chain
 * — so a debug investigation can see the entire fingerprint sequence the
 * resolver scores against, which pairs are pre-barrier (excluded from
 * matching), and exactly which events folded into each pair's input/output.
 *
 * Uses the same split as buildCompletedPairs (via splitCompletedPairs) and
 * the same hashPairRecord, so the pair hashes shown here ARE the real pair
 * fingerprints (scoped by scopeId). This is safe because pair hashes are
 * already HMAC-SHA256 digests — they cannot be reversed to recover content,
 * and they're only useful for log correlation within one process.
 *
 * Returns a multi-line string:
 *   pairs=N barriers=B
 *   [0]pair=abc123 in=[...] out=[...]
 *   [1]pair=def456 in=[...] out=[...]
 *   trailing=[...]
 */
export function describeAllPairs(events, scopeId) {
  const records = splitCompletedPairs(events);
  if (records.length === 0) {
    const trailing = splitContinuityHistory(events).trailingInput;
    const trailingStr = trailing.map(traceEventDigest).join(",");
    return `pairs=0 barriers=0 trailing=[${trailingStr}]`;
  }
  const analysis = scopeId ? analyzeContinuityHistory(events, scopeId) : null;
  const lastBarrierIndex = analysis ? analysis.lastBarrierIndex : -1;
  const lines = [`pairs=${records.length} barriers=${lastBarrierIndex + 1}`];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const pairHash = scopeId ? hashPairRecord(r, scopeId).slice(0, 10) : "no-scope";
    const barrier = i <= lastBarrierIndex ? " BARRIER" : "";
    const inp = r.input.map(traceEventDigest).join(",");
    const out = r.output.map(traceEventDigest).join(",");
    lines.push(`[${i}]pair=${pairHash}${barrier} in=[${inp}] out=[${out}]`);
  }
  const trailing = splitContinuityHistory(events).trailingInput;
  if (trailing.length > 0) {
    const trailingStr = trailing.map(traceEventDigest).join(",");
    lines.push(`trailing=[${trailingStr}]`);
  }
  return lines.join(" | ");
}

/**
 * Diagnostic-only trace of tool call/result linking after normalizeToolLinkage.
 * Shows which tool results linked to which tool calls (by slot or name hint),
 * which results are unlinked (barriers), and which calls are still pending
 * (no matching result). This is critical for debugging dialog identification
 * failures caused by tool linkage changes across translation hops or combo
 * switches.
 *
 * Returns a single-line string:
 *   toolLinks: slot0(search)→result(ok) | slot1(fetch)→pending | orphan-result(unlinked,42c)
 */
export function describeToolLinkage(events) {
  if (!Array.isArray(events)) return "toolLinks: none";
  const normalized = normalizeToolLinkage(events);
  const links = [];
  const callDescriptors = [];
  let pendingCount = 0;
  for (const ev of normalized) {
    if (ev.role === "assistant" && ev.kind === "tool_call") {
      callDescriptors.push({ slot: ev.payload?.slot, name: ev.payload?.name, linked: false });
    }
    if (ev.role === "tool" && ev.kind === "tool_result") {
      if (ev.payload?.unlinked === true) {
        links.push(`orphan-result(unlinked,${typeof ev.payload.content === "string" ? ev.payload.content.length : 0}c)`);
      } else {
        const slot = ev.payload?.slot || "?";
        const name = ev.payload?.name || "?";
        const contentLen = typeof ev.payload?.content === "string" ? ev.payload.content.length : 0;
        links.push(`${slot}(${name})→result(${contentLen}c)`);
        // Mark the matching call as linked
        const call = callDescriptors.find(c => c.slot === slot);
        if (call) call.linked = true;
      }
    }
  }
  // Report pending calls (no matching result) as a single count — listing each
  // one individually produced ~90 `→pending` entries per turn on long tool chains,
  // adding no diagnostic value since "pending" is the default state for every
  // call in history that already has its result linked above.
  for (const c of callDescriptors) {
    if (!c.linked) pendingCount++;
  }
  if (pendingCount > 0) links.push(`pending:${pendingCount}`);
  if (links.length === 0) return "toolLinks: none";
  return `toolLinks: ${links.join(" | ")}`;
}
