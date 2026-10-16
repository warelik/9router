// Adapt Cloud Code's response envelope, keeping the Gemini payload available
// to the existing native response validation, usage observer and client.
function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === "object" && Object.hasOwn(value, "response") && !value.error) {
    const { response, ...metadata } = value;
    if (response === null || typeof response !== "object" || Array.isArray(response) || !Object.keys(response).length) {
      return { error: { code: 502, status: "INTERNAL", message: "Invalid Antigravity response envelope" } };
    }
    return { ...metadata, ...response };
  }
  return value;
}

function responseHeaders(response, contentType) {
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
  headers.set("Content-Type", contentType);
  return headers;
}

function fieldMaskSyntaxError(source, index, reason) {
  return new Error(`Invalid ${source} field mask at position ${index + 1}: ${reason}`);
}

function parseFieldMask(rawMask, source) {
  const text = String(rawMask ?? "").trim();
  if (!text) return null;

  const root = { all: false, children: new Map() };
  let index = 0;
  const fail = reason => { throw fieldMaskSyntaxError(source, index, reason); };
  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index])) index++;
  };
  const readField = () => {
    skipWhitespace();
    if (text[index] === "*") {
      index++;
      return "*";
    }
    const start = index;
    while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index++;
    const field = text.slice(start, index);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) fail("expected a field name");
    return field;
  };
  const childAt = (node, field) => {
    if (field === "*") {
      node.all = true;
      return node;
    }
    let child = node.children.get(field);
    if (!child) {
      child = { all: false, children: new Map() };
      node.children.set(field, child);
    }
    return child;
  };
  const isPathSeparator = character => source === "x-goog-fieldmask"
    ? character === "."
    : character === "/" || character === ".";

  const parseSelectors = (parent, closing) => {
    let selectorCount = 0;
    while (true) {
      skipWhitespace();
      if (index >= text.length) {
        if (closing) fail("expected ')' to close a field group");
        return selectorCount;
      }
      if (text[index] === ")") {
        if (!closing) fail("unexpected ')'");
        index++;
        return selectorCount;
      }
      if (text[index] === ",") fail("empty field selector");

      const fields = [readField()];
      while (true) {
        skipWhitespace();
        if (!isPathSeparator(text[index])) break;
        index++;
        fields.push(readField());
      }
      const wildcardIndex = fields.indexOf("*");
      if (wildcardIndex !== -1 && wildcardIndex !== fields.length - 1) {
        fail("wildcard must be the final path component");
      }

      let target = parent;
      for (const field of fields) target = childAt(target, field);

      skipWhitespace();
      if (text[index] === "(") {
        if (fields.at(-1) === "*") fail("wildcard cannot contain a field group");
        index++;
        if (parseSelectors(target, true) === 0) fail("field group cannot be empty");
      } else target.all = true;
      selectorCount++;

      skipWhitespace();
      if (text[index] === ",") {
        index++;
        skipWhitespace();
        if (index >= text.length || (closing && text[index] === ")")) fail("empty field selector");
        continue;
      }
      if (text[index] === ")") {
        if (!closing) fail("unexpected ')'");
        index++;
        return selectorCount;
      }
      if (index >= text.length) {
        if (closing) fail("expected ')' to close a field group");
        return selectorCount;
      }
      fail("expected ',' or the end of the field mask");
    }
  };

  parseSelectors(root, false);
  if (root.all) return null;
  return root;
}

function nativeResponseMasks(nativeRequest = {}) {
  const query = new URLSearchParams(nativeRequest.query || []);
  const masks = [];
  for (const name of ["fields", "$fields"]) {
    for (const value of query.getAll(name)) {
      const parsed = parseFieldMask(value, name);
      if (parsed) masks.push(parsed);
    }
  }

  const headers = nativeRequest.headers;
  let headerMask = null;
  if (headers && typeof headers.get === "function") {
    headerMask = headers.get("x-goog-fieldmask");
  } else if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "x-goog-fieldmask") continue;
      headerMask = Array.isArray(value) ? value.join(",") : value;
      break;
    }
  }
  if (headerMask != null) {
    const parsed = parseFieldMask(headerMask, "x-goog-fieldmask");
    if (parsed) masks.push(parsed);
  }
  return masks;
}

function isNativeError(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "error");
}

function projectValue(value, selector) {
  if (selector.all) return value;
  if (Array.isArray(value)) {
    // Preserve array positions; an unmatched object item becomes an empty object.
    return value.map(item => {
      const projected = projectValue(item, selector);
      return projected === undefined ? (item === null ? null : {}) : projected;
    });
  }
  if (value === null) return null;
  if (typeof value !== "object") return undefined;

  const projected = Object.create(null);
  for (const [field, childSelector] of selector.children) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (childSelector.all || childSelector.children.size === 0) {
      projected[field] = value[field];
      continue;
    }
    const child = projectValue(value[field], childSelector);
    if (child !== undefined) projected[field] = child;
  }
  return projected;
}

function applyNativeResponseMasks(value, masks) {
  if (!masks.length) return value;
  if (Array.isArray(value)) {
    return value.map(item => isNativeError(item) ? item : applyNativeResponseMasks(item, masks));
  }
  if (isNativeError(value)) return value;

  let projected = value;
  for (const mask of masks) {
    projected = projectValue(projected, mask);
    if (projected === undefined) return {};
  }
  return projected;
}

function isOrdinaryNativeTextPart(part) {
  return part && typeof part.text === "string"
    && !part.thought
    && !part.functionCall && !part.function_call
    && !part.functionResponse && !part.function_response;
}

function nativeJsonFenceOpeningStatus(text) {
  const leadingWhitespace = /^\s*/.exec(text)?.[0].length || 0;
  const opening = text.slice(leadingWhitespace);
  if (!opening) return "start";
  if ("```".startsWith(opening)) return "possible";
  if (!opening.startsWith("```")) return "plain";

  const suffix = opening.slice(3);
  if (/^[ \t]*\r?\n/.test(suffix)) return "open";
  if (/^[ \t]*\r?$/.test(suffix) || "json".startsWith(suffix)) return "possible";
  if (suffix.startsWith("json")) {
    const languageSuffix = suffix.slice(4);
    if (/^[ \t]*\r?\n/.test(languageSuffix)) return "open";
    if (/^[ \t]*\r?$/.test(languageSuffix)) return "possible";
  }
  return "plain";
}

function nativeJsonFenceRemovalRanges(text) {
  const opening = /^(\s*)```(?:json)?[ \t]*\r?\n/.exec(text);
  if (!opening) return null;

  let trimmedEnd = text.length;
  while (trimmedEnd > 0 && /\s/.test(text[trimmedEnd - 1])) trimmedEnd--;
  const closingStart = trimmedEnd - 3;
  if (closingStart < opening[0].length || text.slice(closingStart, trimmedEnd) !== "```") return null;
  const closingLineStart = text.lastIndexOf("\n", closingStart - 1) + 1;
  if (!/^[ \t]*$/.test(text.slice(closingLineStart, closingStart))) return null;

  const inner = text.slice(opening[0].length, closingStart);
  try { JSON.parse(inner); }
  catch { return null; }

  return [
    [opening[1].length, opening[0].length],
    [closingStart, trimmedEnd],
  ];
}

function removeNativeJsonFenceRanges(spans, ranges) {
  const byPart = new Map();
  for (const [rangeStart, rangeEnd] of ranges) {
    for (const span of spans) {
      const overlapStart = Math.max(rangeStart, span.start);
      const overlapEnd = Math.min(rangeEnd, span.end);
      if (overlapStart >= overlapEnd) continue;
      const partRanges = byPart.get(span.part) || [];
      partRanges.push([overlapStart - span.start, overlapEnd - span.start]);
      byPart.set(span.part, partRanges);
    }
  }
  for (const [part, partRanges] of byPart) {
    let text = part.text;
    partRanges.sort((left, right) => right[0] - left[0]);
    for (const [start, end] of partRanges) text = text.slice(0, start) + text.slice(end);
    part.text = text;
  }
}

function nativeCandidateText(candidate) {
  const spans = [];
  let text = "";
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return { text, spans };
  for (const part of parts) {
    if (!isOrdinaryNativeTextPart(part)) continue;
    const start = text.length;
    text += part.text;
    spans.push({ part, start, end: text.length });
  }
  return { text, spans };
}

function normalizeNativeJsonResponse(value) {
  if (Array.isArray(value)) {
    for (const item of value) normalizeNativeJsonResponse(item);
    return value;
  }
  if (!value || typeof value !== "object" || isNativeError(value) || !Array.isArray(value.candidates)) return value;
  for (const candidate of value.candidates) {
    if (!candidate || (candidate.finishReason ?? candidate.finish_reason) !== "STOP") continue;
    const { text, spans } = nativeCandidateText(candidate);
    const ranges = nativeJsonFenceRemovalRanges(text);
    if (ranges) removeNativeJsonFenceRanges(spans, ranges);
  }
  return value;
}

function updateNativeJsonStreamStates(value, states) {
  if (Array.isArray(value)) {
    value.forEach(item => updateNativeJsonStreamStates(item, states));
    return;
  }
  if (!value || typeof value !== "object" || isNativeError(value) || !Array.isArray(value.candidates)) return;

  value.candidates.forEach((candidate, position) => {
    if (!candidate || typeof candidate !== "object") return;
    const candidateIndex = Number.isInteger(candidate.index) ? candidate.index : position;
    let state = states.get(candidateIndex);
    if (!state) {
      state = { status: "start", text: "", spans: [] };
      states.set(candidateIndex, state);
    }

    if (["start", "possible", "open"].includes(state.status)) {
      const parts = candidate.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!isOrdinaryNativeTextPart(part)) continue;
          const start = state.text.length;
          state.text += part.text;
          state.spans.push({ part, start, end: state.text.length });
        }
      }
      if (state.status === "start" || state.status === "possible") {
        state.status = nativeJsonFenceOpeningStatus(state.text);
      }
    }

    const finishReason = candidate.finishReason ?? candidate.finish_reason;
    if (finishReason === "STOP") {
      if (state.status === "open") {
        const ranges = nativeJsonFenceRemovalRanges(state.text);
        if (ranges) {
          removeNativeJsonFenceRanges(state.spans, ranges);
          state.status = "stripped";
        } else state.status = "done";
      } else if (state.status === "start" || state.status === "possible") state.status = "done";
    } else if (finishReason) state.status = "done";
  });
}

function hasPendingNativeJsonFence(states) {
  for (const state of states.values()) {
    if (state.status === "possible" || state.status === "open") return true;
  }
  return false;
}

/**
 * Validate fields/$fields and X-Goog-FieldMask before sending the request upstream.
 * Returns null when valid, otherwise a native Gemini error object for a 400 response.
 */
export function validateAntigravityFieldMask(nativeRequest = {}) {
  try {
    nativeResponseMasks(nativeRequest);
    return null;
  } catch (error) {
    return {
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: error.message,
      },
    };
  }
}

export async function unwrapAntigravityResponse(response, stream, nativeRequest = {}, { jsonOutput = false } = {}) {
  let masks;
  try {
    masks = nativeResponseMasks(nativeRequest);
  } catch (error) {
    if (!response.ok) return response;
    response.body?.cancel().catch(() => {});
    return new Response(JSON.stringify({
      error: { code: 400, status: "INVALID_ARGUMENT", message: error.message },
    }), {
      status: 400,
      statusText: "Bad Request",
      headers: responseHeaders(response, "application/json"),
    });
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) return response;
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    let body = text;
    try {
      const nativeResponse = unwrap(JSON.parse(text));
      const normalized = response.ok && jsonOutput ? normalizeNativeJsonResponse(nativeResponse) : nativeResponse;
      body = JSON.stringify(response.ok ? applyNativeResponseMasks(normalized, masks) : normalized);
    } catch { /* Native core reports invalid JSON. */ }
    return new Response(body, {
      status: response.status, statusText: response.statusText,
      headers: responseHeaders(response, response.headers.get("content-type")),
    });
  }
  // A unary request unexpectedly receiving SSE must still fail the existing
  // native framing check instead of being aggregated into a fabricated answer.
  if (!stream || !response.body) return response;
  const query = new URLSearchParams(nativeRequest.query || []);
  const json = (query.get("alt") || query.get("$alt")) !== "sse";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "", data = [], started = false, failed = false;
  const nativeJsonStates = new Map();
  let pendingNativeResponses = [];
  const writeNativeResponse = (nativeResponse, controller) => {
    const payload = JSON.stringify(response.ok ? applyNativeResponseMasks(nativeResponse, masks) : nativeResponse);
    controller.enqueue(encoder.encode(json ? `${started ? "," : "["}${payload}` : `data: ${payload}\n\n`));
    started = true;
  };
  const flushPendingNativeResponses = controller => {
    for (const nativeResponse of pendingNativeResponses) writeNativeResponse(nativeResponse, controller);
    pendingNativeResponses = [];
  };
  const emit = (value, controller) => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const nativeResponse = unwrap(item);
      if (!response.ok || !jsonOutput) {
        writeNativeResponse(nativeResponse, controller);
        continue;
      }
      if (isNativeError(nativeResponse)) {
        flushPendingNativeResponses(controller);
        writeNativeResponse(nativeResponse, controller);
        continue;
      }

      updateNativeJsonStreamStates(nativeResponse, nativeJsonStates);
      if (pendingNativeResponses.length || hasPendingNativeJsonFence(nativeJsonStates)) {
        pendingNativeResponses.push(nativeResponse);
        if (!hasPendingNativeJsonFence(nativeJsonStates)) flushPendingNativeResponses(controller);
      } else writeNativeResponse(nativeResponse, controller);
    }
  };
  const event = controller => {
    if (!data.length || failed) { data = []; return; }
    const value = data.join("\n");
    data = [];
    // Gemini terminates at EOF. Its finishReason is preserved independently.
    if (value.trim() === "[DONE]") {
      flushPendingNativeResponses(controller);
      return;
    }
    try { emit(JSON.parse(value), controller); }
    catch {
      failed = true;
      flushPendingNativeResponses(controller);
      emit({ error: { code: 502, status: "INTERNAL", message: "Invalid Antigravity stream event" } }, controller);
    }
  };
  const line = (value, controller) => {
    if (!value) event(controller);
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  const consume = (controller, final = false) => {
    let match;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      // Keep a trailing CR until we can distinguish CRLF from a lone CR.
      if (!final && match[0] === "\r" && match.index === buffer.length - 1) break;
      line(buffer.slice(0, match.index), controller);
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (final) {
      if (buffer) line(buffer, controller);
      buffer = "";
      event(controller);
    }
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      // Keep raw upstream activity visible to the existing stall detector,
      // including comments and partial events that do not produce data yet.
      // Google GenAI SDK 2.28 treats SSE comments as JSON. Empty lines are
      // ignored by its parser and still keep upstream activity observable.
      controller.enqueue(encoder.encode(json ? " " : "\n"));
      buffer += decoder.decode(chunk, { stream: true });
      consume(controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      consume(controller, true);
      flushPendingNativeResponses(controller);
      if (json) controller.enqueue(encoder.encode(started ? "]" : "[]"));
    },
  }));
  return new Response(body, {
    status: response.status, statusText: response.statusText,
    headers: responseHeaders(response, json ? "application/json" : "text/event-stream"),
  });
}
