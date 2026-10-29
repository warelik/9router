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
