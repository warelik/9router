import { createHash } from "node:crypto";
import { PORTABLE_COLLABORATION } from "../../config/runtimeConfig.js";
import { FERNET_ENCRYPTED_CONTENT_PREFIX } from "../formats/responsesApi.js";

/** True when opaque agent content would leave no readable task after translation. */
export function hasUndeliverableAgentMessage(input) {
  return Array.isArray(input) && input.some(item => {
    if (item?.type !== "agent_message" || !Array.isArray(item.content)) return false;
    const opaque = item.content.some(part => part?.type === "encrypted_content"
      && typeof part.encrypted_content === "string"
      && part.encrypted_content.startsWith(FERNET_ENCRYPTED_CONTENT_PREFIX));
    if (!opaque) return false;
    let text = item.content.flatMap(part => {
      if (part?.type === "input_text" && typeof part.text === "string") return [part.text];
      if (part?.type === "encrypted_content" && typeof part.encrypted_content === "string"
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
  const lists = [body.tools, ...inputs.filter(item => item?.type === "additional_tools").map(item => item.tools)];
  for (const tools of lists) for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type !== "namespace" && typeof tool?.name === "string") reserved.add(tool.name);
  }
  for (const item of inputs) if (!item?.namespace && typeof item?.name === "string") reserved.add(item.name);
  const aliasFor = (name, type = "function") => {
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
    if (tool?.type !== "namespace" || tool.name !== namespace || !Array.isArray(tool.tools)) return [tool];
    return tool.tools.map(child => {
      if (child?.type !== "function" && child?.type !== "custom") return child;
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
  const input = inputs.map(item => item?.type === "additional_tools" ? { ...item, tools: rewriteTools(item.tools) } : item);
  const rewriteChoice = choice => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return choice;
    if (choice.namespace === namespace && typeof choice.name === "string") {
      const { namespace: _, ...rest } = choice;
      return { ...rest, name: aliasFor(choice.name, choice.type === "custom" ? "custom" : "function") };
    }
    if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) return { ...choice, tools: choice.tools.map(rewriteChoice) };
    return choice;
  };
  const rewritten = { ...body };
  if (Array.isArray(body.tools)) rewritten.tools = tools;
  if (Array.isArray(body.input)) rewritten.input = input.map(item => {
    if ((item?.type === "function_call" || item?.type === "custom_tool_call") && item.namespace === namespace && typeof item.name === "string") {
      const { namespace: _, ...rest } = item;
      return { ...rest, name: aliasFor(item.name, item.type === "custom_tool_call" ? "custom" : "function") };
    }
    return item;
  });
  if (body.tool_choice) rewritten.tool_choice = rewriteChoice(body.tool_choice);
  return { body: toolNameMap.size ? rewritten : body, toolNameMap };
}
