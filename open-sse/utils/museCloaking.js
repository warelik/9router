import { RESPONSES_ITEM, RESPONSES_TOOL } from "../translator/schema/index.js";

// Meta rejects a Muse Code subscription request when a client declaration uses
// a Muse builtin name with a different schema. Unknown function names are
// accepted, so keep the client's schema and rename only its wire identifier.
export const MUSE_TOOL_SUFFIX = "_muse";
const MAX_TOOL_NAME_LENGTH = 64;

// OAuth connections mint a subscription key; API-key connections are pay as
// you go and are not subject to the Muse Code client-attestation contract.
export function isMuseCodeSubscription(credentials) {
  return Boolean(credentials?.accessToken && !credentials?.apiKey);
}

function isClientTool(tool) {
  return (tool?.type === RESPONSES_TOOL.FUNCTION || tool?.type === RESPONSES_TOOL.CUSTOM)
    && typeof tool?.name === "string" && tool.name.length > 0;
}

function allocateAlias(name, usedNames) {
  const base = `${name}${MUSE_TOOL_SUFFIX}`.slice(0, MAX_TOOL_NAME_LENGTH);
  let alias = base;
  for (let index = 2; usedNames.has(alias); index += 1) {
    const suffix = `_${index}`;
    alias = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
  }
  usedNames.add(alias);
  return alias;
}

/**
 * Cloak Responses function/custom tools for a Muse Code subscription.
 * Returns a per-request cloaked → original map for the shared response
 * restorer. Hosted and namespaced tools keep their protocol-defined names.
 */
export function cloakMuseTools(body) {
  if (!Array.isArray(body?.tools)) return { body, toolNameMap: null };

  const usedNames = new Set(body.tools.map(tool => typeof tool?.name === "string" ? tool.name : null).filter(Boolean));
  const aliases = new Map();
  const toolNameMap = new Map();
  const aliasFor = (name) => {
    if (!aliases.has(name)) {
      const alias = allocateAlias(name, usedNames);
      aliases.set(name, alias);
      toolNameMap.set(alias, name);
    }
    return aliases.get(name);
  };

  const tools = body.tools.map(tool => isClientTool(tool) ? { ...tool, name: aliasFor(tool.name) } : tool);
  if (toolNameMap.size === 0) return { body, toolNameMap: null };

  const input = Array.isArray(body.input) ? body.input.map(item => {
    if ((item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL)
      && aliases.has(item.name)) {
      return { ...item, name: aliases.get(item.name) };
    }
    return item;
  }) : body.input;

  const cloakedBody = { ...body, tools, input };
  const choice = body.tool_choice;
  if ((choice?.type === RESPONSES_TOOL.FUNCTION || choice?.type === RESPONSES_TOOL.CUSTOM)
    && aliases.has(choice.name)) {
    cloakedBody.tool_choice = { ...choice, name: aliases.get(choice.name) };
  } else if (choice?.type === RESPONSES_TOOL.ALLOWED_TOOLS && Array.isArray(choice.tools)) {
    cloakedBody.tool_choice = {
      ...choice,
      tools: choice.tools.map(tool => isClientTool(tool) && aliases.has(tool.name)
        ? { ...tool, name: aliases.get(tool.name) }
        : tool),
    };
  }

  return { body: cloakedBody, toolNameMap };
}

// --- Muse Responses tool normalization -------------------------------------
//
// Meta's Responses executor is a strict subset of the Codex dialect:
//   * `search_content_types` is rejected on every tool shape ("only supported
//     for web_search_preview tools" on web_search, and "not supported by the
//     current Responses web_search executor" on web_search_preview itself),
//     while a bare web_search tool is accepted. Codex sends the field
//     whenever the model catalog declares text_and_image search.
//   * `custom` tools are not supported at all ("`custom` tools are not
//     supported on this endpoint"), which rejects Codex's freeform
//     apply_patch declaration before the first token.
//
// Custom tools are therefore sent as ordinary function tools carrying one
// raw `input` string — the same shape the Responses→Chat translator uses —
// and the replies are converted back with restoreMuseCustomToolCalls (JSON
// bodies) and convertMuseCustomStreamEvent (SSE). Identity travels as
// `customToolNames`: the wire name for a top-level tool, or
// `namespace/name` for a namespaced child (namespaces keep their children,
// only the child's type changes).

/** Identity key of a custom tool: its name, namespaced when it has one. */
export function museCustomToolKey(name, namespace) {
  return typeof namespace === "string" && namespace ? `${namespace}/${name}` : name;
}

function customToolAsFunction(tool) {
  const formatHint = [tool.format?.syntax, tool.format?.definition].filter(Boolean).join("\n");
  return {
    type: RESPONSES_TOOL.FUNCTION,
    name: tool.name,
    description: [String(tool.description || ""), formatHint].filter(Boolean).join("\n\n"),
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Raw freeform input for this custom tool" },
      },
      required: ["input"],
      additionalProperties: false,
    },
    strict: false,
  };
}

// Returns { tools, changed }; the input list and its tools are never mutated.
// Every namespaced child is also recorded in namespaceToolNames under its
// flattened `namespace.child` spelling: Meta answers namespace calls in
// exactly that dotted form without a namespace field, which strict
// Responses clients (Codex) refuse to route ("unsupported call"). The
// descriptors let the shared name restorer split them back.
function normalizeMuseToolList(tools, customToolNames, namespaceToolNames, namespace = null) {
  if (!Array.isArray(tools)) return { tools, changed: false };
  let changed = false;
  const out = tools.map(tool => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
    let next = tool;
    if (Object.hasOwn(next, "search_content_types")) {
      next = { ...next };
      delete next.search_content_types;
      changed = true;
    }
    if (namespace && (next.type === RESPONSES_TOOL.FUNCTION || next.type === RESPONSES_TOOL.CUSTOM)
      && typeof next.name === "string" && next.name) {
      const dotted = `${namespace}.${next.name}`;
      if (!namespaceToolNames.has(dotted)) {
        namespaceToolNames.set(dotted, {
          name: next.name,
          namespace,
          type: next.type === RESPONSES_TOOL.CUSTOM ? RESPONSES_TOOL.CUSTOM : RESPONSES_TOOL.FUNCTION,
        });
      }
    }
    if (next.type === RESPONSES_TOOL.NAMESPACE && Array.isArray(next.tools)) {
      const children = normalizeMuseToolList(next.tools, customToolNames, namespaceToolNames, next.name);
      if (children.changed) {
        changed = true;
        return { ...next, tools: children.tools };
      }
      return next;
    }
    if (next.type === RESPONSES_TOOL.CUSTOM && typeof next.name === "string" && next.name) {
      customToolNames.add(museCustomToolKey(next.name, namespace));
      changed = true;
      return customToolAsFunction(next);
    }
    return next;
  });
  return { tools: changed ? out : tools, changed };
}

function normalizeMuseToolChoice(choice, customToolNames) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return { choice, changed: false };
  if (choice.type === RESPONSES_TOOL.CUSTOM && typeof choice.name === "string") {
    customToolNames.add(museCustomToolKey(choice.name, choice.namespace));
    return { choice: { ...choice, type: RESPONSES_TOOL.FUNCTION }, changed: true };
  }
  if (choice.type === RESPONSES_TOOL.ALLOWED_TOOLS && Array.isArray(choice.tools)) {
    let changed = false;
    const tools = choice.tools.map(entry => {
      const normalized = normalizeMuseToolChoice(entry, customToolNames);
      changed = changed || normalized.changed;
      return normalized.choice;
    });
    return { choice: changed ? { ...choice, tools } : choice, changed };
  }
  return { choice, changed: false };
}

/**
 * Rewrite a Responses request into the subset Meta accepts: hosted search
 * tools lose `search_content_types`, custom tools (declarations, history
 * calls/outputs and tool_choice) become their function form. Returns the
 * client-side custom identities; the caller maps top-level names through
 * any later renaming (cloaking) before handing the set to the restorers.
 */
export function normalizeMuseResponsesTools(body) {
  const customToolNames = new Set();
  const namespaceToolNames = new Map();
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, customToolNames, namespaceToolNames };

  let changed = false;
  const out = { ...body };

  const tools = normalizeMuseToolList(body.tools, customToolNames, namespaceToolNames);
  if (tools.changed) { out.tools = tools.tools; changed = true; }

  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const input = body.input.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      if (item.type === RESPONSES_ITEM.ADDITIONAL_TOOLS) {
        const declared = normalizeMuseToolList(item.tools, customToolNames, namespaceToolNames);
        if (!declared.changed) return item;
        inputChanged = true;
        return { ...item, tools: declared.tools };
      }
      if (item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
        if (typeof item.name === "string" && item.name) {
          customToolNames.add(museCustomToolKey(item.name, item.namespace));
        }
        inputChanged = true;
        const converted = {
          ...item,
          type: RESPONSES_ITEM.FUNCTION_CALL,
          arguments: JSON.stringify({ input: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? "") }),
        };
        delete converted.input;
        return converted;
      }
      if (item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) {
        inputChanged = true;
        return { ...item, type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT };
      }
      return item;
    });
    if (inputChanged) { out.input = input; changed = true; }
  }

  const choice = normalizeMuseToolChoice(body.tool_choice, customToolNames);
  if (choice.changed) { out.tool_choice = choice.choice; changed = true; }

  return { body: changed ? out : body, customToolNames, namespaceToolNames };
}

/** The freeform input inside a converted function call's arguments. */
export function extractMuseCustomInput(argumentsText) {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* incomplete or raw freeform input */ }
  return argumentsText;
}

/** True when a function_call item is one of the converted custom tools. */
export function isMuseCustomToolCall(item, customToolNames) {
  if (item?.type !== RESPONSES_ITEM.FUNCTION_CALL || typeof item.name !== "string") return false;
  if (customToolNames?.has(museCustomToolKey(item.name, item.namespace))) return true;
  // Meta flattens a namespaced call into the dotted name without a
  // namespace field; its identity key is the same pair joined by "/".
  if (!item.namespace) {
    const dot = item.name.indexOf(".");
    if (dot > 0 && customToolNames?.has(`${item.name.slice(0, dot)}/${item.name.slice(dot + 1)}`)) return true;
  }
  return false;
}

function museCustomItem(item) {
  const converted = { ...item, type: RESPONSES_ITEM.CUSTOM_TOOL_CALL, input: extractMuseCustomInput(item.arguments) };
  delete converted.arguments;
  return converted;
}

/**
 * Convert function_call items of converted custom tools back to
 * custom_tool_call in a JSON payload (a Response body, a lifecycle event's
 * response.output, a lone output item). Payloads sharing no converted call
 * are returned by identity.
 */
export function restoreMuseCustomToolCalls(payload, customToolNames) {
  if (!customToolNames?.size || !payload) return payload;
  if (Array.isArray(payload)) {
    let changed = false;
    const out = payload.map(item => {
      const restored = restoreMuseCustomToolCalls(item, customToolNames);
      changed = changed || restored !== item;
      return restored;
    });
    return changed ? out : payload;
  }
  if (typeof payload !== "object") return payload;
  if (isMuseCustomToolCall(payload, customToolNames)) return museCustomItem(payload);

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };
  for (const key of ["output", "item", "response", "data"]) {
    const value = payload[key];
    if (value && typeof value === "object") {
      const restored = restoreMuseCustomToolCalls(value, customToolNames);
      if (restored !== value) put(key, restored);
    }
  }
  return out;
}

/**
 * Convert one upstream Responses SSE event for the passthrough stream.
 * `pending` is a per-stream Map of item_id → accumulated function arguments
 * for converted calls: their argument deltas are JSON fragments of the
 * `{input}` wrapper, so they are buffered and emitted once, unwrapped, as
 * custom_tool_call_input delta+done when the arguments complete — mirroring
 * the translated stream. Returns the events to forward (possibly none);
 * unconverted events are returned by identity.
 */
export function convertMuseCustomStreamEvent(event, customToolNames, pending) {
  if (!event || typeof event !== "object" || !customToolNames?.size) return [event];

  switch (event.type) {
    case "response.output_item.added": {
      if (!isMuseCustomToolCall(event.item, customToolNames)) return [event];
      if (typeof event.item.id === "string") pending.set(event.item.id, "");
      return [{ ...event, item: { ...museCustomItem(event.item), input: "" } }];
    }
    case "response.function_call_arguments.delta": {
      if (!pending.has(event.item_id)) return [event];
      if (typeof event.delta === "string") pending.set(event.item_id, pending.get(event.item_id) + event.delta);
      return [];
    }
    case "response.function_call_arguments.done": {
      if (!pending.has(event.item_id)) return [event];
      const input = extractMuseCustomInput(typeof event.arguments === "string" ? event.arguments : pending.get(event.item_id));
      const { arguments: _arguments, delta: _delta, ...common } = event;
      return [
        { ...common, type: "response.custom_tool_call_input.delta", delta: input },
        { ...common, type: "response.custom_tool_call_input.done", input },
      ];
    }
    case "response.output_item.done": {
      if (typeof event.item?.id === "string") pending.delete(event.item.id);
      if (!isMuseCustomToolCall(event.item, customToolNames)) return [event];
      return [{ ...event, item: museCustomItem(event.item) }];
    }
    default: {
      const restored = restoreMuseCustomToolCalls(event, customToolNames);
      return [restored];
    }
  }
}
