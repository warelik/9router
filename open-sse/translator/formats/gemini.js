// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { isGemini4Model } from "../../providers/capabilities.js";
import { FILE_EXTENSION_MIME } from "../../config/runtimeConfig.js";

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format", "multipleOf",
  // Array keywords the Gemini schema proto has no field for. Agent tool
  // schemas set these routinely, and one occurrence rejects the whole request
  // with "Unknown name ...: Cannot find field".
  "uniqueItems", "contains",
  // 2020-12 keywords with no Gemini equivalent
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  // Tuple-array keywords; converted to items first, leftovers stripped
  "prefixItems", "additionalItems",
  // Claude rejects these in VALIDATED mode
  "default", "examples",
  // JSON Schema meta keywords
  "$schema", "$defs", "definitions", "const", "$ref", "$comment",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  "deprecated", "readOnly", "writeOnly",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords
  "title", "optional", "deprecated", "if", "then", "else", "contentMediaType", "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor",
  // Non-standard annotation/error keywords used by some MCP tool schemas (#4283).
  // Gemini's schema proto has no field for these and rejects the whole request with
  // "Unknown name X: Cannot find field" if any nested schema node carries them.
  "errorMessage", "errorMessages", "x-errorMessage", "x-errorMessages",
  "markdownDescription", "x-intellij-html-description",
  "x-taplo-info", "x-taplo", "doNotSuggest", "suggestSortText",
  "minProperties", "maxProperties"
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

function fileMimeType(filename, explicit) {
  if (typeof explicit === "string" && explicit.includes("/")) return explicit;
  const ext = typeof filename === "string" ? filename.split(".").pop().toLowerCase() : "";
  const mime = FILE_EXTENSION_MIME[ext];
  return typeof mime === "string" ? mime : undefined;
}

function dataUrlToInlinePart(url) {
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) return null;
  const mimeType = url.substring(5, commaIndex).split(";")[0];
  return { inlineData: { mime_type: mimeType, data: url.substring(commaIndex + 1) } };
}

function appendFilePart(parts, file) {
  if (!file || typeof file !== "object") return;
  const mime = fileMimeType(file.filename, file.mime_type || file.mimeType);
  const data = file.file_data;
  if (typeof data === "string" && data.startsWith("data:")) {
    const part = dataUrlToInlinePart(data);
    if (part) parts.push(part);
  } else if (typeof data === "string" && /^https?:\/\//.test(data)) {
    parts.push({ fileData: { fileUri: data, ...(mime ? { mimeType: mime } : {}) } });
  } else if (typeof data === "string" && data) {
    parts.push({ inlineData: { mime_type: mime || "application/octet-stream", data } });
  } else if (typeof file.file_url === "string" && /^https?:\/\//.test(file.file_url)) {
    parts.push({ fileData: { fileUri: file.file_url, ...(mime ? { mimeType: mime } : {}) } });
  }
}

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === OPENAI_BLOCK.TEXT) {
        parts.push({ text: item.text });
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" }
        });
      } else if (item.type === OPENAI_BLOCK.INPUT_AUDIO && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data }
        });
      } else if (item.type === OPENAI_BLOCK.AUDIO_URL && item.audio_url?.url?.startsWith("data:")) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.FILE) {
        appendFilePart(parts, item.file);
      } else if (item.type === RESPONSES_ITEM.INPUT_FILE) {
        appendFilePart(parts, item);
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === OPENAI_BLOCK.TEXT).map(c => c.text).join(separator);
  }
  return "";
}

// Try parse JSON safely (null fallback on parse error; re-export keeps legacy API)
export function tryParseJSON(str) {
  return safeParseJSON(str, null);
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
const SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_SINGLE_KEYS = new Set(["items", "additionalProperties", "contains", "not", "if", "then", "else"]);

function eachChildSchema(node, fn) {
  for (const key of Object.keys(node)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      const map = node[key];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        for (const child of Object.values(map)) {
          if (child && typeof child === "object") fn(child);
        }
      }
    } else if (SCHEMA_ARRAY_KEYS.has(key)) {
      if (Array.isArray(node[key])) {
        for (const child of node[key]) {
          if (child && typeof child === "object") fn(child);
        }
      }
    } else if (SCHEMA_SINGLE_KEYS.has(key)) {
      const child = node[key];
      if (child && typeof child === "object" && !Array.isArray(child)) fn(child);
    }
  }
}

// Helper: Remove unsupported keywords recursively from object/array
// Also strips all vendor extension fields (x- prefixed) not supported by Gemini
function removeUnsupportedKeywords(obj, keywords) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

  for (const key of Object.keys(obj)) {
    if (keywords.includes(key) || key.startsWith("x-")) {
      delete obj[key];
    }
  }

  eachChildSchema(obj, (child) => removeUnsupportedKeywords(child, keywords));
}

// Convert const to enum
function convertConstToEnum(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

  if (obj.const !== undefined && !obj.enum) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  eachChildSchema(obj, convertConstToEnum);
}

// Convert enum values to strings (Gemini requires string enum values + explicit type:"string")
function convertEnumValuesToStrings(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

  if (obj.enum && Array.isArray(obj.enum)) {
    obj.enum = obj.enum.map(v => String(v));
    // Gemini API requires type:"string" when enum is present — without it returns 400
    if (!obj.type) {
      obj.type = "string";
    }
  }

  eachChildSchema(obj, convertEnumValuesToStrings);
}

// Merge allOf schemas
function mergeAllOf(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

  if (obj.allOf && Array.isArray(obj.allOf)) {
    const merged = {};

    for (const item of obj.allOf) {
      if (item.properties) {
        if (!merged.properties) merged.properties = {};
        Object.assign(merged.properties, item.properties);
      }
      if (item.required && Array.isArray(item.required)) {
        if (!merged.required) merged.required = [];
        for (const req of item.required) {
          if (!merged.required.includes(req)) {
            merged.required.push(req);
          }
        }
      }
    }

    delete obj.allOf;
    if (merged.properties) obj.properties = { ...obj.properties, ...merged.properties };
    if (merged.required) obj.required = [...(obj.required || []), ...merged.required];
  }

  eachChildSchema(obj, mergeAllOf);
}

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Flatten anyOf/oneOf
function flattenAnyOfOneOf(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

  if (obj.anyOf && Array.isArray(obj.anyOf) && obj.anyOf.length > 0) {
    const nonNullSchemas = obj.anyOf.filter(s => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.anyOf;
      Object.assign(obj, selected);
    }
  }

  if (obj.oneOf && Array.isArray(obj.oneOf) && obj.oneOf.length > 0) {
    const nonNullSchemas = obj.oneOf.filter(s => s && s.type !== "null");
    if (nonNullSchemas.length > 0) {
      const bestIdx = selectBest(nonNullSchemas);
      const selected = nonNullSchemas[bestIdx];
      delete obj.oneOf;
      Object.assign(obj, selected);
    }
  }

  eachChildSchema(obj, flattenAnyOfOneOf);
}

// Flatten type arrays
function flattenTypeArrays(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

  if (obj.type && Array.isArray(obj.type)) {
    const nonNullTypes = obj.type.filter(t => t !== "null");
    if (nonNullTypes.length === 0) {
      obj.type = "string";
    } else if (nonNullTypes.length === 1) {
      obj.type = nonNullTypes[0];
    } else {
      // Multiple types: choose best fitting type (prefer structural clues then string over boolean/number)
      if (obj.properties && nonNullTypes.includes("object")) {
        obj.type = "object";
      } else if (obj.items && typeof obj.items === "object" && Object.keys(obj.items).length > 0 && obj.items.type && nonNullTypes.includes("array")) {
        obj.type = "array";
      } else if (nonNullTypes.includes("string")) {
        obj.type = "string";
      } else if (nonNullTypes.includes("number")) {
        obj.type = "number";
      } else if (nonNullTypes.includes("integer")) {
        obj.type = "integer";
      } else if (nonNullTypes.includes("boolean")) {
        obj.type = "boolean";
      } else {
        obj.type = nonNullTypes[0];
      }
    }
  }

  eachChildSchema(obj, flattenTypeArrays);
}

// Infer missing type=object when properties exist (Gemini requires explicit type)
function ensureObjectType(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  if (obj.properties && !obj.type) obj.type = "object";
  eachChildSchema(obj, ensureObjectType);
}

// Convert prefixItems (tuple validation) to items — Gemini cannot express tuples,
// and a type:"array" schema without items is rejected with "missing field"
function convertPrefixItems(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

  if (Array.isArray(obj.prefixItems) && obj.prefixItems.length > 0) {
    const variants = obj.prefixItems.filter(s => s && s.type !== "null");
    if (!obj.items && variants.length === 1) {
      obj.items = variants[0];
    } else if (!obj.items && variants.length > 1) {
      obj.items = { anyOf: variants };
    }
    delete obj.prefixItems;
  }

  eachChildSchema(obj, convertPrefixItems);
}

// Gemini requires items on every type:"array" schema — fill a permissive placeholder
function ensureArrayItems(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  if (obj.type === "array") {
    if (!obj.items || typeof obj.items !== "object" || Object.keys(obj.items).length === 0) {
      obj.items = { type: "string" };
    } else if (!obj.items.type) {
      if (obj.items.properties) {
        obj.items.type = "object";
      } else if (obj.items.items) {
        obj.items.type = "array";
      } else {
        obj.items.type = "string";
      }
    }
  }
  eachChildSchema(obj, ensureArrayItems);
}

// Gemini Schema proto validation rules:
// 1. Schema.items predicate: $type == Type.ARRAY. If type is not "array", items field MUST NOT exist.
// 2. Schema.properties / required predicate: $type == Type.OBJECT. If type is not "object", properties and required MUST NOT exist.
function enforceTypeConstraints(obj) {
  if (!obj || typeof obj !== "object") return;

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      enforceTypeConstraints(value);
    }
  }

  if (obj.type === "array") {
    delete obj.properties;
    delete obj.required;
    if (!obj.items || typeof obj.items !== "object" || Object.keys(obj.items).length === 0) {
      obj.items = { type: "string" };
    } else if (!obj.items.type) {
      if (obj.items.properties) {
        obj.items.type = "object";
      } else if (obj.items.items) {
        obj.items.type = "array";
      } else {
        obj.items.type = "string";
      }
    }
  } else {
    // Non-array schemas MUST NOT carry items
    delete obj.items;
  }

  if (obj.type !== "object") {
    delete obj.properties;
    delete obj.required;
  }
}

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Mutate directly (schema is only used once per request)
  let cleaned = schema;

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);
  convertEnumValuesToStrings(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.5: Infer missing type=object when properties exist (Gemini requirement)
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 4: Cleanup required fields recursively
  function cleanupRequired(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;

    if (obj.required && Array.isArray(obj.required) && obj.properties) {
      const validRequired = obj.required.filter(field =>
        Object.prototype.hasOwnProperty.call(obj.properties, field)
      );
      if (validRequired.length === 0) {
        delete obj.required;
      } else {
        obj.required = validRequired;
      }
    }

    // Recurse into nested schemas
    eachChildSchema(obj, cleanupRequired);
  }

  cleanupRequired(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  function addPlaceholders(obj) {
    if (!obj || typeof obj !== "object") return;

    // Empty schema {} (no type, no properties) after $ref removal — treat as object with placeholder
    if (Object.keys(obj).length === 0) {
      obj.type = "object";
      obj.properties = {
        reason: {
          type: "string",
          description: "Brief explanation of why you are calling this tool"
        }
      };
      obj.required = ["reason"];
      return;
    }

    if (obj.type === "object") {
      if (!obj.properties || Object.keys(obj.properties).length === 0) {
        obj.properties = {
          reason: {
            type: "string",
            description: "Brief explanation of why you are calling this tool"
          }
        };
        obj.required = ["reason"];
      }
    }

    // Recurse into nested schemas
    eachChildSchema(obj, addPlaceholders);
  }

  addPlaceholders(cleaned);

  // Phase 6: Enforce Gemini protobuf type predicates (items only on array, properties/required only on object)
  enforceTypeConstraints(cleaned);

  return cleaned;
}

const PROTO_SCHEMA_TYPES = new Set(["OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN", "NULL"]);
export function lowerProtoSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    for (const item of schema) lowerProtoSchemaTypes(item);
    return schema;
  }
  if (typeof schema.type === "string" && PROTO_SCHEMA_TYPES.has(schema.type)) {
    schema.type = schema.type.toLowerCase();
  }
  eachChildSchema(schema, lowerProtoSchemaTypes);
  return schema;
}

const LEGACY_PROTO_SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "items", "properties", "required", "propertyOrdering"]);
export function isLegacyGeminiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  for (const key of Object.keys(schema)) {
    if (!LEGACY_PROTO_SCHEMA_KEYS.has(key)) return false;
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.every((v) => typeof v === "string"))) return false;
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties)) return false;
    for (const child of Object.values(schema.properties)) {
      if (!isLegacyGeminiSchema(child)) return false;
    }
  }
  if (schema.items !== undefined && !isLegacyGeminiSchema(schema.items)) return false;
  return true;
}

export function adaptAIStudioStructuredOutput(body) {
  if (!body || typeof body !== "object") return body;
  const key = body.generation_config ? "generation_config" : "generationConfig";
  const generation = body[key];
  const schema = generation?.responseJsonSchema ?? generation?.response_json_schema;
  const mime = generation?.responseMimeType ?? generation?.response_mime_type;
  const conflictingAliases = generation && (
    (Object.hasOwn(generation, "responseJsonSchema") && Object.hasOwn(generation, "response_json_schema")) ||
    (Object.hasOwn(generation, "responseMimeType") && Object.hasOwn(generation, "response_mime_type"))
  );
  // The browser-authenticated API accepts the current responseFormat wire;
  // its deprecated responseJsonSchema alias fails. Move the opaque schema
  // to the documented replacement without compiling or relaxing it.
  if (!conflictingAliases && schema !== undefined && mime === "application/json"
    && !generation.responseFormat && !generation.response_format && !generation.responseSchema && !generation.response_schema) {
    const mapped = { ...generation, responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } } };
    delete mapped.responseJsonSchema;
    delete mapped.response_json_schema;
    delete mapped.responseMimeType;
    delete mapped.response_mime_type;
    return { ...body, [key]: mapped };
  }
  return body;
}

// Gemini / Cloud Code treat a `$ref` key inside functionResponse.response as a
// pointer to functionResponse.parts and reject the request with
// "The referenced name `#/$defs/...` in function_response.response does not match
// to a display_name in the function_response.parts". Tool results that carry a
// JSON Schema / OpenAPI document (webfetch, read, MCP) hit this, so rename the key.
export const GEMINI_RESERVED_RESPONSE_KEYS = { "$ref": "_ref" };

// Recursively rename reserved keys in a tool-result payload (arrays/objects only)
export function sanitizeFunctionResponsePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeFunctionResponsePayload);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[GEMINI_RESERVED_RESPONSE_KEYS[key] ?? key] = sanitizeFunctionResponsePayload(val);
  }
  return out;
}

// Return the part with a sanitized functionResponse.response (same reference when untouched)
function sanitizeFunctionResponsePart(part) {
  const response = part?.functionResponse?.response;
  if (!response || typeof response !== "object") return part;
  return { ...part, functionResponse: { ...part.functionResponse, response: sanitizeFunctionResponsePayload(response) } };
}

// Gemini 4 rejects a merged user turn whose last part is not a functionResponse (#4802)
function moveFunctionResponsesLast(parts) {
  const responses = parts.filter(p => p.functionResponse);
  if (!responses.length) return parts;
  return [...parts.filter(p => !p.functionResponse), ...responses];
}

// Merge adjacent same-role messages, strip empty parts, ensure initial and terminal user turns
export function normalizeGeminiContents(contents, modelOrOptions = null, extraOptions = {}) {
  const optionsObject = modelOrOptions && typeof modelOrOptions === "object"
    && Object.hasOwn(modelOrOptions, "synthesizeTerminalToolResponse");
  const model = optionsObject ? null : modelOrOptions;
  const options = optionsObject ? modelOrOptions : extraOptions;
  const synthesizeTerminalToolResponse = options?.synthesizeTerminalToolResponse ?? true;
  const frLast = isGemini4Model(model);
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts.filter(p => p && Object.keys(p).length > 0).map(sanitizeFunctionResponsePart);
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === c.role) {
      last.parts.push(...parts);
      if (frLast) last.parts = moveFunctionResponsesLast(last.parts);
    } else out.push({ ...c, parts: [...parts] });
  }
  if (out.length > 0 && out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: "..." }] });
  }
  if (out.length > 0 && out.at(-1).role === "model") {
    const fnCalls = (out.at(-1).parts || []).filter(p => p && p.functionCall);
    if (fnCalls.length > 0) {
      if (synthesizeTerminalToolResponse) {
        const responses = fnCalls.map(p => {
          const call = p.functionCall || {};
          const fr = {
            name: call.name || "tool",
            response: { result: "Continue." }
          };
          if (call.id) fr.id = call.id;
          return { functionResponse: fr };
        });
        out.push({ role: "user", parts: responses });
      }
    } else {
      out.push({ role: "user", parts: [{ text: "Continue." }] });
    }
  }
  return out;
}

