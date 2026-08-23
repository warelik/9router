/**
 * Utility to extract thoughts in chronological/ordered way from diverse model payloads
 * and to selectively package them respecting character budgets.
 */

// Each adapter reads thoughts only from the known, explicit response-shape paths
// for its vendor — never by walking arbitrary nested JSON. A reasoning-like field
// buried in an unrelated nested object (e.g. inside a tool result payload) must
// NOT be picked up as a model thought, so there is deliberately no generic
// recursive fallback here. Response shapes are disjoint enough (choices vs content
// array vs candidates vs output vs message) that running every adapter over the
// same object is safe: only the one matching the actual shape ever contributes.

function collectOpenAIResponseThoughts(value, out) {
  const choices = value?.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const msg = choice?.message;
    const reasoning = msg?.reasoning_content;
    if (typeof reasoning === "string" && reasoning) out.push(reasoning);
    const thinking = msg?.thinking;
    if (typeof thinking === "string" && thinking) out.push(thinking);
  }
}

function collectClaudeResponseThoughts(value, out) {
  const content = value?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if ((block?.type === "thinking" || block?.type === "redacted_thinking") && typeof block.thinking === "string" && block.thinking) {
      out.push(block.thinking);
    }
  }
}

function collectGeminiResponseThoughts(value, out) {
  const geminiResponse = value?.response?.candidates ? value.response : (value?.candidates ? value : null);
  if (!geminiResponse) return;
  for (const candidate of geminiResponse.candidates || []) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.thought === true && typeof part.text === "string" && part.text) out.push(part.text);
    }
  }
}

// Mirrors extractReasoningText() in translator/request/openai-responses.js —
// same fields, same priority (summary[].text, then content[].text).
function collectResponsesThoughts(value, out) {
  const output = value?.output;
  if (!Array.isArray(output)) return;
  for (const item of output) {
    if (item?.type !== "reasoning") continue;
    if (Array.isArray(item.summary)) {
      const txt = item.summary.map(s => s?.text || "").filter(Boolean).join("\n");
      if (txt) { out.push(txt); continue; }
    }
    if (Array.isArray(item.content)) {
      const txt = item.content.map(c => c?.text || "").filter(Boolean).join("\n");
      if (txt) { out.push(txt); continue; }
    }
    if (typeof item.text === "string" && item.text) out.push(item.text);
  }
}

function collectOllamaResponseThoughts(value, out) {
  const thinking = value?.message?.thinking;
  if (typeof thinking === "string" && thinking) out.push(thinking);
}

/**
 * Returns an ordered array of thoughts { text: string, source: string } from a
 * semantic provider response, dispatched through explicit per-format adapters
 * (OpenAI / Claude / Gemini / Responses / Ollama) — never a generic recursive walk.
 */
export function collectResponseThoughts(value) {
  if (!value || typeof value !== "object") return [];
  const out = [];
  collectOpenAIResponseThoughts(value, out);
  collectClaudeResponseThoughts(value, out);
  collectGeminiResponseThoughts(value, out);
  collectResponsesThoughts(value, out);
  collectOllamaResponseThoughts(value, out);

  return out.filter(t => t && typeof t === "string" && t.trim() !== "")
    .map(t => ({ text: t.trim(), source: "extracted" }));
}

// Single-thought size ceiling — oversize traces are skipped with a warning,
// never truncated (a partial reasoning trace is worse than no trace at all).
export const MAX_RECENT_THOUGHT_CHARS = 32000;

// Total injected-prompt budget across all replayed thoughts. Distinct from the
// per-thought cap above: reusing MAX_RECENT_THOUGHT_CHARS as the total budget
// would silently shrink the replay window to roughly one max-size thought.
// Whole thoughts that don't fit are dropped oldest-first — never truncated.
export const CONTINUITY_MAX_PROMPT_CHARS = 96000;

/**
 * Drops any thought record too large to store safely. Does not dedupe or
 * truncate — an oversize record is dropped whole, with a warning.
 */
export function filterOversizeThoughts(thoughts, maxChars = MAX_RECENT_THOUGHT_CHARS) {
  const out = [];
  for (const t of Array.isArray(thoughts) ? thoughts : []) {
    if (typeof t !== "string" || !t) continue;
    if (t.length > maxChars) {
      console.warn(`[continuity] skipping oversize reasoning checkpoint (${t.length} chars)`);
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Build budget-restricted thoughts chronologically.
 * Takes up to `count` thoughts, works backward from the newest,
 * and packages them up to `maxChars` budget.
 */
export function budgetThoughts(thoughts, count = 7, maxChars = CONTINUITY_MAX_PROMPT_CHARS) {
  if (!Array.isArray(thoughts) || thoughts.length === 0) return [];
  const candidates = thoughts.slice(-count);
  const result = [];
  let currentLength = 0;

  // Process from newest to oldest
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const thought = candidates[i];
    if (typeof thought !== "string" || !thought) continue;

    if (currentLength + thought.length <= maxChars) {
      result.unshift(thought); // insert at start to keep chronological order
      currentLength += thought.length;
    } else {
      // Oversized element doesn't fit, stop here to avoid partial splits
      break;
    }
  }

  return result;
}

/**
 * Incrementally accumulates streaming provider-format reasoning deltas into
 * ordered segments. Claude's content_block_start/stop framing marks distinct
 * thinking blocks as distinct segments; other vendor shapes stream one
 * continuous reasoning phase per turn and collapse into a single segment —
 * there is no reliable block-boundary signal for those today.
 */
export function createStreamingThoughtAccumulator() {
  const segments = [];
  let hasOpenSegment = false;
  let openBlockIndex = null;

  function append(text) {
    if (!text) return;
    if (!hasOpenSegment) {
      segments.push("");
      hasOpenSegment = true;
    }
    segments[segments.length - 1] += text;
  }

  function push(item) {
    if (!item || typeof item !== "object") return;

    if (item.type === "content_block_start" && item.content_block?.type === "thinking") {
      segments.push("");
      hasOpenSegment = true;
      openBlockIndex = item.index;
      return;
    }
    if (item.type === "content_block_stop" && item.index === openBlockIndex) {
      hasOpenSegment = false;
      openBlockIndex = null;
      return;
    }

    if (typeof item.delta?.thinking === "string") append(item.delta.thinking);
    if (typeof item.choices?.[0]?.delta?.reasoning_content === "string") append(item.choices[0].delta.reasoning_content);
    if (typeof item.choices?.[0]?.delta?.thinking === "string") append(item.choices[0].delta.thinking);

    const parts = item.candidates?.[0]?.content?.parts || item.response?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.thought === true && typeof part.text === "string") append(part.text);
      }
    }

    if (typeof item.message?.thinking === "string") append(item.message.thinking);
    if (item.type === "response.reasoning_summary_text.delta" && typeof item.delta === "string") append(item.delta);
  }

  function finalize() {
    return segments.map(s => s.trim()).filter(Boolean);
  }

  return { push, finalize };
}
