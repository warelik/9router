import { createHash } from "node:crypto";
import { PORTABLE_COLLABORATION } from "../../config/runtimeConfig.js";
import { FERNET_ENCRYPTED_CONTENT_PREFIX } from "../formats/responsesApi.js";
import { RESPONSES_ITEM, RESPONSES_TOOL } from "../schema/index.js";

/** True when opaque agent content would leave no readable task after translation. */
export function hasUndeliverableAgentMessage(input) {
  return Array.isArray(input) && input.some(item => {
    if (item?.type !== RESPONSES_ITEM.AGENT_MESSAGE || !Array.isArray(item.content)) return false;
    const opaque = item.content.some(part => part?.type === RESPONSES_ITEM.ENCRYPTED_CONTENT
      && typeof part.encrypted_content === "string"
      && part.encrypted_content.startsWith(FERNET_ENCRYPTED_CONTENT_PREFIX));
    if (!opaque) return false;
    let text = item.content.flatMap(part => {
      if (part?.type === RESPONSES_ITEM.INPUT_TEXT && typeof part.text === "string") return [part.text];
      if (part?.type === RESPONSES_ITEM.ENCRYPTED_CONTENT && typeof part.encrypted_content === "string"
        && !part.encrypted_content.startsWith(FERNET_ENCRYPTED_CONTENT_PREFIX)) return [part.encrypted_content];
      return [];
    }).join("\n").trim();
    if (text.startsWith("Message Type:")) {
      const lines = text.split(/\r?\n/);
      while (lines.length && (!lines[0].trim() || /^(Message Type|Task name|Sender):/.test(lines[0].trimStart()))) lines.shift();
      text = lines.join("\n").replace(/^\s*Payload:[ \t]*/, "");
    }
    return text.trim() === "";
  });
}

export function preparePortableCollaboration(body) {
  const namespace = PORTABLE_COLLABORATION.namespace;
  const toolNameMap = new Map();
  const aliases = new Map();
  const reserved = new Set();
  const inputs = Array.isArray(body.input) ? body.input : [];
  const lists = [body.tools, ...inputs.filter(item => item?.type === RESPONSES_ITEM.ADDITIONAL_TOOLS).map(item => item.tools)];
  for (const tools of lists) for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type !== RESPONSES_TOOL.NAMESPACE && typeof tool?.name === "string") reserved.add(tool.name);
  }
  for (const item of inputs) if (!item?.namespace && typeof item?.name === "string") reserved.add(item.name);
  const aliasFor = (name, type = RESPONSES_TOOL.FUNCTION) => {
    if (aliases.has(name)) return aliases.get(name);
    const hash = createHash("sha256").update(JSON.stringify([namespace, name])).digest("hex").slice(0, 16);
    const base = PORTABLE_COLLABORATION.aliasPrefix + String(name).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 30) + "_" + hash;
    let alias = base;
    for (let n = 1; reserved.has(alias); n++) alias = base.slice(0, 58) + "_" + n;
    reserved.add(alias); aliases.set(name, alias);
    toolNameMap.set(alias, { name, namespace, type });
    return alias;
  };
  const rewriteTools = tools => !Array.isArray(tools) ? tools : tools.flatMap(tool => {
    if (tool?.type !== RESPONSES_TOOL.NAMESPACE || tool.name !== namespace || !Array.isArray(tool.tools)) return [tool];
    return tool.tools.map(child => {
      if (child?.type !== RESPONSES_TOOL.FUNCTION && child?.type !== RESPONSES_TOOL.CUSTOM) return child;
      const description = [tool.description, child.description].filter(text => typeof text === "string" && text).join("\n");
      const out = { ...child, name: aliasFor(child.name, child.type), ...(description ? { description } : {}) };
      const message = child.parameters?.properties?.message;
      if (PORTABLE_COLLABORATION.messageTools.includes(child.name) && message && typeof message === "object" && !Array.isArray(message)) {
        const { encrypted, ...plainMessage } = message;
        out.parameters = { ...child.parameters, properties: { ...child.parameters.properties, message: plainMessage } };
      }
      return out;
    });
  });
  // Allocate declarations before history so collisions resolve consistently.
  const tools = rewriteTools(body.tools);
  const input = inputs.map(item => item?.type === RESPONSES_ITEM.ADDITIONAL_TOOLS ? { ...item, tools: rewriteTools(item.tools) } : item);
  const rewriteChoice = choice => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return choice;
    if (choice.namespace === namespace && typeof choice.name === "string") {
      const { namespace: _, ...rest } = choice;
      return { ...rest, name: aliasFor(choice.name, choice.type === RESPONSES_TOOL.CUSTOM ? RESPONSES_TOOL.CUSTOM : RESPONSES_TOOL.FUNCTION) };
    }
    if (choice.type === RESPONSES_TOOL.ALLOWED_TOOLS && Array.isArray(choice.tools)) return { ...choice, tools: choice.tools.map(rewriteChoice) };
    return choice;
  };
  const rewritten = { ...body };
  if (Array.isArray(body.tools)) rewritten.tools = tools;
  if (Array.isArray(body.input)) rewritten.input = input.map(item => {
    if ((item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) && item.namespace === namespace && typeof item.name === "string") {
      const { namespace: _, ...rest } = item;
      return { ...rest, name: aliasFor(item.name, item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL ? RESPONSES_TOOL.CUSTOM : RESPONSES_TOOL.FUNCTION) };
    }
    return item;
  });
  if (body.tool_choice) rewritten.tool_choice = rewriteChoice(body.tool_choice);
  return { body: toolNameMap.size ? rewritten : body, toolNameMap };
}
