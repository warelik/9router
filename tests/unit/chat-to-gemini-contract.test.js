import { describe, it, expect, vi, beforeEach } from "vitest";

const { network } = vi.hoisted(() => ({ network: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: network }));
vi.mock("../../open-sse/executors/index.js", async () => {
  const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
  const executors = new Map();
  return { getExecutor(provider) {
    if (!executors.has(provider)) executors.set(provider, new DefaultExecutor(provider));
    return executors.get(provider);
  } };
});
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => new Proxy({}, { get: (_t, name) => name === "then" ? undefined : vi.fn() }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }),
}));

import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  openaiToGeminiRequest,
  openaiToGeminiCLIRequest,
  openaiToAntigravityRequest,
} from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToVertexRequest } from "../../open-sse/translator/request/openai-to-vertex.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import {
  normalizeGeminiContents,
  convertOpenAIContentToParts,
  cleanJSONSchemaForAntigravity,
  isLegacyGeminiSchema,
} from "../../open-sse/translator/formats/gemini.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { storeGeminiThoughtSignature } from "../../open-sse/services/thoughtSignatureStore.js";
import {
  DEFAULT_THINKING_VERTEX_SIGNATURE,
  DEFAULT_THINKING_AG_SIGNATURE,
} from "../../open-sse/config/defaultThinkingSignature.js";

const MODEL = "gemini-3.5-flash-lite";
const user = (content) => ({ role: "user", content });
const AG_CREDENTIALS = { projectId: "p", connectionId: "conn-contract" };

const o2g = (body, credentials = null) =>
  translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, MODEL, body, true, credentials, "gemini");
const o2cli = (body, credentials = { accessToken: "t", projectId: "p" }) =>
  translateRequest(FORMATS.OPENAI, FORMATS.GEMINI_CLI, MODEL, body, true, credentials, "gemini-cli");
const o2vx = (body, credentials = null) =>
  translateRequest(FORMATS.OPENAI, FORMATS.VERTEX, MODEL, body, true, credentials, "vertex");
const o2ag = (body, credentials = AG_CREDENTIALS) =>
  translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, MODEL, body, true, credentials, "antigravity");

const inner = {
  plain: (out) => out,
  cli: (out) => out.request,
  vertex: (out) => out,
  ag: (out) => out.request,
};
const WRAPPERS = { plain: o2g, cli: o2cli, vertex: o2vx, ag: o2ag };

describe("instructions: every system/developer text block lands once, in order", () => {
  it.each(Object.keys(WRAPPERS))("aggregates interleaved roles and multi-block content (%s)", (w) => {
    const out = inner[w](WRAPPERS[w]({
      messages: [
        { role: "system", content: "S1" },
        user("u1"),
        { role: "developer", content: "D1" },
        { role: "system", content: [
          { type: "text", text: "S2a" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          { type: "text", text: "S2b" },
        ] },
        user("u2"),
      ],
    }));
    expect(out.systemInstruction.parts).toEqual([
      { text: "S1" }, { text: "D1" }, { text: "S2a" }, { text: "S2b" },
    ]);
    const texts = out.contents.flatMap((c) => c.parts.filter((p) => p.text).map((p) => p.text));
    expect(texts).toEqual(["u1", "u2"]);
  });

  it("instruction-only request gets the stable ... user trigger, not instruction copies", () => {
    const out = o2g({ messages: [{ role: "system", content: "ONLY_SYS" }] });
    expect(out.systemInstruction.parts).toEqual([{ text: "ONLY_SYS" }]);
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "..." }] }]);
    expect(JSON.stringify(out.contents)).not.toContain("ONLY_SYS");
  });

  it("developer-only history behaves the same", () => {
    const out = o2g({ messages: [{ role: "developer", content: [{ type: "text", text: "DEV_ONLY" }] }] });
    expect(out.systemInstruction.parts).toEqual([{ text: "DEV_ONLY" }]);
    expect(out.contents).toEqual([{ role: "user", parts: [{ text: "..." }] }]);
  });

  it("developer instructions arriving through the Responses first hop are retained", () => {
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, {
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "DEV_RULE" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      instructions: "TOP_INSTRUCTIONS",
    }, true, null, "gemini");
    expect(JSON.stringify(out.systemInstruction)).toContain("TOP_INSTRUCTIONS");
    expect(JSON.stringify(out.systemInstruction)).toContain("DEV_RULE");
  });

  it("same instructions replay to a stable turn scope; different contexts differ", () => {
    const mk = (sys) => ({
      messages: [
        { role: "system", content: sys },
        { role: "developer", content: "shared dev" },
        user("q"),
        { role: "assistant", content: "a" },
        user("again"),
      ],
    });
    const c1 = {}, c2 = {}, c3 = {};
    openaiToGeminiRequest(MODEL, mk("rules A"), true, c1);
    openaiToGeminiRequest(MODEL, mk("rules A"), true, c2);
    openaiToGeminiRequest(MODEL, mk("rules B"), true, c3);
    expect(c1._geminiTurnScope).toBe(c2._geminiTurnScope);
    expect(c1._geminiTurnScope).not.toBe(c3._geminiTurnScope);
    expect(c1._geminiTurnScope).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("schema carrier: legacy parameters vs lossless parametersJsonSchema", () => {
  const toolWith = (parameters) => ({
    type: "function",
    function: { name: "do_thing", description: "d", ...(parameters !== undefined ? { parameters } : {}) },
  });
  const declOf = (out) => innerOfTools(out).functionDeclarations[0];
  const innerOfTools = (out) => out.tools?.[0] || out.request?.tools?.[0];

  it("basic JSON Schema keeps the legacy parameters wire", () => {
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    for (const w of Object.keys(WRAPPERS)) {
      const decl = declOf(WRAPPERS[w]({ messages: [user("x")], tools: [toolWith(schema)] }));
      expect(decl.parameters).toEqual(schema);
      expect(decl).not.toHaveProperty("parametersJsonSchema");
    }
  });

  it("a cleaning-unsafe schema rides parametersJsonSchema untouched", () => {
    const schema = {
      $defs: { n: { type: "integer", minimum: 0 } },
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 40 },
        count: { $ref: "#/$defs/n" },
        choice: { anyOf: [{ type: "string" }, { type: "integer" }] },
        level: { enum: [1, 2, 3] },
        meta: { type: "object", default: { type: "customer" } },
      },
      required: ["title"],
      additionalProperties: false,
    };
    for (const w of Object.keys(WRAPPERS)) {
      const decl = declOf(WRAPPERS[w]({ messages: [user("x")], tools: [toolWith(schema)] }));
      expect(decl).not.toHaveProperty("parameters");
      expect(decl.parametersJsonSchema).toEqual(schema);
    }
  });

  it("property names that collide with keyword names survive cleaning", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" }, default: { type: "string" }, const: { type: "string" },
        enum: { type: "integer" }, type: { type: "string" }, required: { type: "string" },
        items: { type: "string" }, "x-customer": { type: "boolean" },
      },
      required: ["title"],
    };
    const out = o2g({ messages: [user("x")], tools: [toolWith(schema)] });
    expect(declOf(out).parameters).toEqual(schema);
  });

  it("cleaning does not mutate the caller's schema object", () => {
    const schema = {
      type: "object",
      properties: { deep: { type: "object", properties: { n: { type: "integer" } } } },
      "x-extra": { nested: { type: "no" } },
    };
    const snapshot = structuredClone(schema);
    o2g({ messages: [user("x")], tools: [toolWith(schema)] });
    expect(schema).toEqual(snapshot);
  });

  it("no declared schema and an explicitly empty schema both stay reason-free", () => {
    for (const parameters of [undefined, {}, { type: "object", properties: {} }]) {
      const out = o2g({ messages: [user("x")], tools: [toolWith(parameters)] });
      const decl = declOf(out);
      expect(JSON.stringify(decl)).not.toContain("reason");
      if (parameters === undefined) {
        expect(decl).not.toHaveProperty("parameters");
        expect(decl).not.toHaveProperty("parametersJsonSchema");
      } else {
        expect(decl).not.toHaveProperty("parameters");
        expect(decl.parametersJsonSchema).toEqual(parameters);
      }
    }
  });

  it("cleaning-invariant schemas that proto Schema cannot hold still use the JSON carrier", () => {
    const cases = [
      { type: "array", items: [{ type: "string" }, { type: "integer" }] },
      { type: "array", items: true },
      { type: "object", properties: { flag: false } },
    ];
    for (const schema of cases) {
      const decl = declOf(o2g({ messages: [user("x")], tools: [toolWith(schema)] }));
      expect(decl.parametersJsonSchema, JSON.stringify(schema)).toEqual(schema);
      expect(decl).not.toHaveProperty("parameters");
    }
  });

  it("schemas the cleaner would alter also use the JSON carrier", () => {
    const cases = [
      { type: "object", properties: { q: { type: "string" } }, not: { type: "object" } },
      { type: "object", properties: { q: { type: "string" } }, if: { type: "string" }, then: { type: "string" } },
      { type: "object", properties: { q: { type: "string" } }, additionalProperties: { type: "string" } },
    ];
    for (const schema of cases) {
      const decl = declOf(o2g({ messages: [user("x")], tools: [toolWith(schema)] }));
      expect(decl.parametersJsonSchema, JSON.stringify(schema)).toEqual(schema);
      expect(decl).not.toHaveProperty("parameters");
    }
  });

  it("proto-compatible keyword sets keep the parameters wire", () => {
    const schema = {
      type: "object", description: "d", nullable: false,
      properties: { a: { type: "string" }, n: { type: "integer" } },
      required: ["a"], propertyOrdering: ["a", "n"],
    };
    expect(declOf(o2g({ messages: [user("x")], tools: [toolWith(schema)] })).parameters).toEqual(schema);
    const enumSchema = { type: "string", enum: ["x", "y"] };
    expect(declOf(o2g({ messages: [user("x")], tools: [toolWith(enumSchema)] })).parameters).toEqual(enumSchema);
  });

  it("a proto-style schema stays in parameters when cleaning is a no-op; if it must move to the JSON carrier its types are lowercased", () => {
    const clean = { type: "OBJECT", properties: { n: { type: "INTEGER" }, z: { type: "NULL" } } };
    const kept = declOf(o2g({ messages: [user("x")], tools: [toolWith(clean)] }));
    expect(kept.parameters).toEqual(clean);

    const rich = { type: "OBJECT", properties: { n: { type: "INTEGER", title: "n" }, z: { type: "NULL" } } };
    const decl = declOf(o2g({ messages: [user("x")], tools: [toolWith(rich)] }));
    expect(decl).not.toHaveProperty("parameters");
    expect(decl.parametersJsonSchema).toEqual({ type: "object", properties: { n: { type: "integer", title: "n" }, z: { type: "null" } } });
  });

  it("instance-valued enum/const objects bypass the legacy cleaner entirely across all wrappers", () => {
    const cases = [
      { type: "object", properties: { payload: { type: "object", enum: [{ toString: "literal", type: "INTEGER", "x-meta": 1 }] } } },
      { type: "object", properties: { payload: { type: "object", const: { toString: "literal", type: "INTEGER" } } } },
    ];
    for (const schema of cases) {
      for (const w of Object.keys(WRAPPERS)) {
        const decl = declOf(WRAPPERS[w]({ messages: [user("x")], tools: [toolWith(schema)] }));
        expect(decl, `${w} ${JSON.stringify(schema)}`).not.toHaveProperty("parameters");
        expect(decl.parametersJsonSchema, w).toEqual(schema);
      }
    }
  });
});

describe("cleanJSONSchemaForAntigravity traversal is schema-position aware", () => {
  it("property names that equal keyword names are data, never stripped", () => {
    const schema = {
      type: "object",
      properties: {
        definitions: { type: "string" },
        $defs: { type: "integer" },
        patternProperties: { type: "string" },
        dependentSchemas: { type: "boolean" },
        not: { type: "string" },
        "x-meta": { type: "string" },
      },
      required: ["definitions", "patternProperties", "not"],
    };
    const cleaned = cleanJSONSchemaForAntigravity(structuredClone(schema));
    expect(cleaned.properties).toEqual(schema.properties);
    expect(cleaned.required).toEqual(schema.required);
  });

  it("isLegacyGeminiSchema accepts proto shapes and rejects non-proto ones", () => {
    expect(isLegacyGeminiSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"], propertyOrdering: ["a"], enum: undefined })).toBe(true);
    expect(isLegacyGeminiSchema({ type: "array", items: { type: "string" } })).toBe(true);
    expect(isLegacyGeminiSchema({ type: "string", enum: ["a"] })).toBe(true);
    expect(isLegacyGeminiSchema({ type: "string", enum: [] })).toBe(true);
    expect(isLegacyGeminiSchema(null)).toBe(false);
    expect(isLegacyGeminiSchema("string")).toBe(false);
    expect(isLegacyGeminiSchema([])).toBe(false);
    expect(isLegacyGeminiSchema({ type: "object", not: {} })).toBe(false);
    expect(isLegacyGeminiSchema({ anyOf: [{ type: "string" }] })).toBe(false);
    expect(isLegacyGeminiSchema({ type: "array", items: [{ type: "string" }] })).toBe(false);
    expect(isLegacyGeminiSchema({ type: "object", properties: { flag: false } })).toBe(false);
    expect(isLegacyGeminiSchema({ type: "object", properties: [] })).toBe(false);
    expect(isLegacyGeminiSchema({ type: "object", $defs: { x: {} } })).toBe(false);
    for (const bad of [[1, 2], [true], [null], [{}], "x"]) {
      expect(isLegacyGeminiSchema({ type: "object", enum: bad }), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("tool choice mapping", () => {
  const tools = [{ type: "function", function: { name: "pick_me", parameters: { type: "object", properties: {} } } }];
  const modeOf = (out) => (out.toolConfig || out.request?.toolConfig)?.functionCallingConfig?.mode;
  const namesOf = (out) => (out.toolConfig || out.request?.toolConfig)?.functionCallingConfig?.allowedFunctionNames;

  it.each(Object.keys(WRAPPERS))("maps auto/none/required (%s)", (w) => {
    for (const [choice, mode] of [["auto", "AUTO"], ["none", "NONE"], ["required", "ANY"]]) {
      const out = WRAPPERS[w]({ messages: [user("x")], tools, tool_choice: choice });
      expect(modeOf(out), `${w} ${choice}`).toBe(mode);
    }
  });

  it.each(Object.keys(WRAPPERS))("named function maps to ANY + sanitized allowedFunctionNames (%s)", (w) => {
    const nested = WRAPPERS[w]({ messages: [user("x")], tools, tool_choice: { type: "function", function: { name: "pick me!" } } });
    expect(modeOf(nested)).toBe("ANY");
    expect(namesOf(nested)).toEqual(["pick_me_"]);

    const flat = WRAPPERS[w]({ messages: [user("x")], tools, tool_choice: { type: "function", name: "pick_me" } });
    expect(modeOf(flat)).toBe("ANY");
    expect(namesOf(flat)).toEqual(["pick_me"]);
  });

  it("absent tool_choice keeps provider defaults: nothing for plain/vertex, VALIDATED for cli/ag", () => {
    expect(o2g({ messages: [user("x")], tools })).not.toHaveProperty("toolConfig");
    expect(o2vx({ messages: [user("x")], tools })).not.toHaveProperty("toolConfig");
    expect(o2cli({ messages: [user("x")], tools }).request.toolConfig)
      .toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(o2ag({ messages: [user("x")], tools }).request.toolConfig)
      .toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });

  it("Antigravity executor preserves a translated toolConfig instead of overwriting with VALIDATED", () => {
    const envelope = o2ag({ messages: [user("x")], tools, tool_choice: "auto" });
    const out = new AntigravityExecutor().transformRequest(MODEL, envelope, true, AG_CREDENTIALS);
    expect(out.request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });

  it("Antigravity executor keeps VALIDATED default when no tool_choice was provided", () => {
    const envelope = o2ag({ messages: [user("x")], tools });
    const out = new AntigravityExecutor().transformRequest(MODEL, envelope, true, AG_CREDENTIALS);
    expect(out.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });
});

describe("tool history is chronological, lossless, and unfabricated", () => {
  const call = (id, name, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });
  const toolMsg = (id, content) => ({ role: "tool", tool_call_id: id, content });
  const functionResponsesOf = (out) => out.contents.flatMap((c) => c.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse));
  const functionCallsOf = (out) => out.contents.flatMap((c) => c.parts.filter((p) => p.functionCall).map((p) => p.functionCall));

  it("parallel calls keep original ids (call.1 vs call1) and results follow message order", () => {
    const out = o2g({
      messages: [
        user("go"),
        { role: "assistant", content: null, tool_calls: [call("call.1", "alpha"), call("call1", "beta")] },
        toolMsg("call1", "B-RESULT"),
        toolMsg("call.1", '{"nested":1}'),
        user("next"),
      ],
    });
    const calls = functionCallsOf(out);
    expect(calls.map((c) => c.id)).toEqual(["call.1", "call1"]);
    expect(calls.map((c) => c.name)).toEqual(["alpha", "beta"]);
    const resps = functionResponsesOf(out);
    expect(resps.map((r) => r.id)).toEqual(["call1", "call.1"]);
    expect(resps.map((r) => r.name)).toEqual(["beta", "alpha"]);
    expect(resps[0].response).toEqual({ result: "B-RESULT" });
    expect(resps[1].response).toEqual({ nested: 1 });
  });

  it("result contract: Struct objects pass unchanged, everything else wraps under result", () => {
    const cases = [
      ["sunny", { result: "sunny" }],
      ["false", { result: false }],
      ["0", { result: 0 }],
      ["null", { result: null }],
      [null, { result: null }],
      [undefined, { result: null }],
      ['{"error":"denied"}', { error: "denied" }],
      [{ already: "object" }, { already: "object" }],
      ["[1,2]", { result: [1, 2] }],
      ["not json {", { result: "not json {" }],
    ];
    for (const [content, expected] of cases) {
      const out = o2g({
        messages: [user("go"), { role: "assistant", content: null, tool_calls: [call("c1", "f")] }, toolMsg("c1", content), user("n")],
      });
      expect(functionResponsesOf(out)[0].response, JSON.stringify(content)).toEqual(expected);
    }
  });

  it("opaque ids that collide with Object.prototype keys still resolve their declared name", () => {
    const out = o2g({
      messages: [
        user("go"),
        { role: "assistant", content: null, tool_calls: [call("__proto__", "proto_fn")] },
        toolMsg("__proto__", "ok"),
        user("n"),
      ],
    });
    const fr = functionResponsesOf(out)[0];
    expect(fr.name).toBe("proto_fn");
    expect(fr.id).toBe("__proto__");
  });

  it("never fabricates a success response for a call with no result", () => {
    const out = o2g({
      messages: [user("go"), { role: "assistant", content: null, tool_calls: [call("c1", "f")] }],
    });
    expect(functionResponsesOf(out)).toEqual([]);
    expect(out.contents.at(-1).role).toBe("model");
    const midHistory = o2g({
      messages: [user("go"), { role: "assistant", content: null, tool_calls: [call("c1", "f")] }, user("anyway")],
    });
    expect(functionResponsesOf(midHistory)).toEqual([]);
  });

  it("default normalizeGeminiContents still fabricates for other consumers; the option does not", () => {
    const contents = [user("x") && { role: "user", parts: [{ text: "x" }] }, { role: "model", parts: [{ functionCall: { id: "c1", name: "f" } }] }];
    const withDefault = normalizeGeminiContents(contents);
    expect(withDefault.at(-1).parts[0].functionResponse.response).toEqual({ result: "Continue." });
    const off = normalizeGeminiContents(contents, { synthesizeTerminalToolResponse: false });
    expect(off.at(-1).role).toBe("model");
  });
});

describe("translator metadata stays off the provider body", () => {
  it("_customToolNames/_toolNameMap ride the envelope top level only", () => {
    const intermediate = openaiResponsesToOpenAIRequest(MODEL, {
      input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec", format: { syntax: "lark" } }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      ],
    }, true, null);
    expect(intermediate._customToolNames).toEqual(["exec"]);

    for (const w of Object.keys(WRAPPERS)) {
      const out = WRAPPERS[w]({ ...intermediate, _toolNameMap: new Map([["a", "b"]]) });
      expect(out._customToolNames).toEqual(["exec"]);
      expect(out._toolNameMap instanceof Map ? [...out._toolNameMap] : out._toolNameMap).toEqual([["a", "b"]]);
      const payload = inner[w](out);
      for (const section of [payload.contents, payload.tools, payload.systemInstruction]) {
        if (section !== undefined) {
          expect(JSON.stringify(section)).not.toContain("_customToolNames");
          expect(JSON.stringify(section)).not.toContain("_toolNameMap");
        }
      }
      const decls = payload.tools?.[0]?.functionDeclarations || [];
      expect(decls.map((d) => d.name)).toContain("exec");
    }
  });
});

describe("media content", () => {
  it("retained input_file inline data and file URLs become inlineData/fileData", () => {
    const parts = convertOpenAIContentToParts([
      { type: "input_file", filename: "d.pdf", file_data: "data:application/pdf;base64,JVBER" },
      { type: "input_file", filename: "a.txt", file_url: "https://files.example/a.txt" },
      { type: "input_file", file_id: "file-abc", filename: "x.pdf" },
      { type: "file", file: { filename: "b.pdf", file_data: "UkFXUkFXX1JBVw==" } },
      { type: "file", file: { filename: "c.pdf", file_data: "https://files.example/c.pdf" } },
    ]);
    expect(parts[0]).toEqual({ inlineData: { mime_type: "application/pdf", data: "JVBER" } });
    expect(parts[1]).toEqual({ fileData: { fileUri: "https://files.example/a.txt", mimeType: "text/plain" } });
    expect(parts.filter((p) => p.fileData || p.inlineData)).toHaveLength(4);
    expect(parts[2]).toEqual({ inlineData: { mime_type: "application/pdf", data: "UkFXUkFXX1JBVw==" } });
    expect(parts[3]).toEqual({ fileData: { fileUri: "https://files.example/c.pdf", mimeType: "application/pdf" } });
  });

  it("assistant multimodal content keeps its media parts instead of flattening to text", () => {
    const out = o2g({
      messages: [
        user("look"),
        { role: "assistant", content: [
          { type: "text", text: "see this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ] },
        user("more"),
      ],
    });
    const modelTurn = out.contents.find((c) => c.role === "model");
    expect(modelTurn.parts).toContainEqual({ text: "see this" });
    expect(modelTurn.parts.some((p) => p.inlineData?.data === "AAAA")).toBe(true);
  });
});

describe("generation settings and structured output", () => {
  it("maps scalar controls, preferring max_completion_tokens over max_tokens", () => {
    const out = o2g({
      messages: [user("x")],
      temperature: 0.5, top_p: 0.9, top_k: 40,
      max_tokens: 100, max_completion_tokens: 77,
      stop: ["END", "STOP"], seed: 42,
      presence_penalty: 0.3, frequency_penalty: -0.1,
    });
    expect(out.generationConfig).toMatchObject({
      temperature: 0.5, topP: 0.9, topK: 40,
      maxOutputTokens: 77, stopSequences: ["END", "STOP"], seed: 42,
      presencePenalty: 0.3, frequencyPenalty: -0.1,
    });
  });

  it("n/logprobs/top_logprobs stay unmapped — unconsumed candidates and probabilities are not activated", () => {
    const out = o2g({ messages: [user("x")], n: 2, logprobs: true, top_logprobs: 5 });
    expect(out.generationConfig).not.toHaveProperty("candidateCount");
    expect(out.generationConfig).not.toHaveProperty("responseLogprobs");
    expect(out.generationConfig).not.toHaveProperty("logprobs");
  });

  it.each([
    ["gemini-3.1-pro-preview", 128, 65535, { thinkingLevel: "high", includeThoughts: true }],
    ["gemini-2.5-pro", 1024, 32768, { thinkingBudget: 24576, includeThoughts: true }],
  ])("retains upstream thinking answer headroom on %s", (model, cap, expectedFloor, thinking) => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI_CLI, model, {
      messages: [user("x")],
      max_completion_tokens: cap,
      reasoning_effort: "high",
    }, true, { accessToken: "t", projectId: "p" }, "gemini-cli");
    expect(out.request.generationConfig.maxOutputTokens).toBe(expectedFloor);
    expect(out.request.generationConfig.thinkingConfig).toMatchObject(thinking);
  });

  it("stop string becomes a one-element stopSequences", () => {
    const out = o2g({ messages: [user("x")], stop: "END" });
    expect(out.generationConfig.stopSequences).toEqual(["END"]);
  });

  it("response_format json_object/json_schema map to responseMimeType/responseJsonSchema", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } }, $defs: { a: { type: "string" } }, additionalProperties: false };
    const obj = o2g({ messages: [user("x")], response_format: { type: "json_object" } });
    expect(obj.generationConfig.responseMimeType).toBe("application/json");
    expect(obj.generationConfig).not.toHaveProperty("responseJsonSchema");

    const js = o2g({ messages: [user("x")], response_format: { type: "json_schema", json_schema: { name: "s", schema } } });
    expect(js.generationConfig.responseMimeType).toBe("application/json");
    expect(js.generationConfig.responseJsonSchema).toEqual(schema);
  });

  it("first-hop Responses text.format lands the same way", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const out = o2g({ messages: [user("x")], text: { format: { type: "json_schema", name: "s", schema } } });
    expect(out.generationConfig.responseMimeType).toBe("application/json");
    expect(out.generationConfig.responseJsonSchema).toEqual(schema);
    const jo = o2g({ messages: [user("x")], text: { format: { type: "json_object" } } });
    expect(jo.generationConfig.responseMimeType).toBe("application/json");
  });
});

describe("Vertex post-processing", () => {
  it("replaces only the known synthetic signatures, preserving a cached real one", () => {
    storeGeminiThoughtSignature("call-real", "REAL_PROVIDER_SIG", "sess-vertex", MODEL);
    const body = (id) => ({
      messages: [
        user("q"),
        { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: id, content: "r" },
        user("n"),
      ],
    });
    const withReal = openaiToVertexRequest(MODEL, body("call-real"), true, { _clientSessionId: "sess-vertex" });
    const realCall = withReal.contents.flatMap((c) => c.parts).find((p) => p.functionCall);
    expect(realCall.thoughtSignature).toBe("REAL_PROVIDER_SIG");
    expect(realCall.thoughtSignature).not.toBe(DEFAULT_THINKING_VERTEX_SIGNATURE);

    const withDefault = openaiToVertexRequest(MODEL, body("call-uncached"), true, null);
    const defaultCall = withDefault.contents.flatMap((c) => c.parts).find((p) => p.functionCall);
    expect(defaultCall.thoughtSignature).toBe(DEFAULT_THINKING_VERTEX_SIGNATURE);
    expect(defaultCall.thoughtSignature).not.toBe(DEFAULT_THINKING_AG_SIGNATURE);
    expect(defaultCall.functionCall.id).toBeUndefined();
  });
});

describe("Antigravity executor contract on translated Gemini bodies", () => {
  const executor = () => new AntigravityExecutor();
  const tools = [
    { type: "function", function: { name: "rich", parameters: { type: "object", properties: { s: { type: "string", minLength: 2 } } } } },
    { type: "function", function: { name: "plain", parameters: { type: "object", properties: { q: { type: "string" } } } } },
    { type: "function", function: { name: "noargs" } },
  ];

  it("keeps parametersJsonSchema carriers verbatim, cleans legacy parameters, injects no placeholder", () => {
    const envelope = o2ag({ messages: [user("x")], tools });
    const out = executor().transformRequest(MODEL, envelope, true, AG_CREDENTIALS);
    const decls = out.request.tools[0].functionDeclarations;
    const rich = decls.find((d) => d.name === "rich");
    expect(rich.parametersJsonSchema).toEqual({ type: "object", properties: { s: { type: "string", minLength: 2 } } });
    expect(rich).not.toHaveProperty("parameters");
    const plain = decls.find((d) => d.name === "plain");
    expect(plain.parameters).toEqual({ type: "object", properties: { q: { type: "string" } } });
    const noargs = decls.find((d) => d.name === "noargs");
    expect(JSON.stringify(noargs)).not.toContain("reason");
  });

  it("does not re-add a fabricated terminal functionResponse after executor normalization", () => {
    const envelope = o2ag({
      messages: [user("go"), { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }],
      tools,
    });
    const out = executor().transformRequest(MODEL, envelope, true, AG_CREDENTIALS);
    expect(out.request.contents.at(-1).role).toBe("model");
    expect(JSON.stringify(out.request.contents)).not.toContain("Continue.");
  });

  it("Claude-backed envelopes keep the legacy placeholder and VALIDATED toolConfig", () => {
    const envelope = {
      model: "claude-sonnet-4.5",
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "naked" },
          { name: "typed", parameters: { type: "object", properties: { q: { type: "string" } } } },
          { name: "nulled", parameters: null },
          { name: "falsed", parameters: false },
        ] }],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
      },
    };
    const out = executor().transformRequest("claude-sonnet-4.5", envelope, true, AG_CREDENTIALS);
    const decls = out.request.tools[0].functionDeclarations;
    expect(decls.find((d) => d.name === "naked").parameters.properties.reason).toBeDefined();
    expect(decls.find((d) => d.name === "nulled").parameters.properties.reason).toBeDefined();
    expect(decls.find((d) => d.name === "falsed").parameters.properties.reason).toBeDefined();
    expect(decls.find((d) => d.name === "typed").parameters).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(out.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
  });
});

describe.each([["gemini"], ["aistudio"]])("translated Chat → %s through the real chat core", (provider) => {
  const quiet = Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine"].map((n) => [n, vi.fn()]));
  const reply = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };

  const wireBody = () => JSON.parse(network.mock.calls.at(-1)[1].body);
  const wireUrl = () => network.mock.calls.at(-1)[0];

  beforeEach(() => {
    network.mockReset();
  });

  async function runChat(stream, extra = {}) {
    return handleChatCore({
      body: {
        model: `${provider}/${MODEL}`,
        stream,
        messages: [
          { role: "system", content: "S1" },
          { role: "developer", content: "D1" },
          user("q1"),
          { role: "assistant", content: null, tool_calls: [
            { id: "call.1", type: "function", function: { name: "alpha", arguments: '{"a":1}' } },
            { id: "call1", type: "function", function: { name: "beta", arguments: "{}" } },
            { id: "c-miss", type: "function", function: { name: "ghost", arguments: "{}" } },
          ] },
          { role: "tool", tool_call_id: "call1", content: '["x","y"]' },
          { role: "tool", tool_call_id: "call.1", content: '{"err":"nope"}' },
          user("next"),
        ],
        tools: [
          { type: "function", function: { name: "rich", description: "d", parameters: { type: "object", properties: { s: { type: "string", minLength: 2 } } } } },
          { type: "function", function: { name: "plain", description: "d", parameters: { type: "object", properties: { q: { type: "string" } } } } },
        ],
        tool_choice: { type: "function", function: { name: "plain" } },
        reasoning_effort: "high",
        max_completion_tokens: 128,
        ...extra,
      },
      modelInfo: { provider, model: MODEL },
      credentials: { apiKey: "offline-key", connectionId: "offline-contract" },
      log: quiet,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
      connectionId: "offline-contract",
      rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    });
  }

  it.each([["JSON", false], ["SSE", true]])("carries instructions, schema carrier, toolConfig, chronological results, cap+thinking (%s)", async (_label, stream) => {
    network.mockImplementation(async () => stream
      ? new Response(`data: ${JSON.stringify(reply)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : Response.json(structuredClone(reply)));
    const result = await runChat(stream);
    expect(result.success).toBe(true);

    const wb = wireBody();
    expect(wb.systemInstruction.parts).toEqual([{ text: "S1" }, { text: "D1" }]);

    const decls = wb.tools[0].functionDeclarations;
    expect(decls.find((d) => d.name === "rich").parametersJsonSchema)
      .toEqual({ type: "object", properties: { s: { type: "string", minLength: 2 } } });
    expect(decls.find((d) => d.name === "plain").parameters)
      .toEqual({ type: "object", properties: { q: { type: "string" } } });

    expect(wb.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["plain"] } });
    expect(wb.generationConfig.maxOutputTokens).toBe(65535);
    expect(wb.generationConfig.thinkingConfig).toMatchObject({ thinkingLevel: "high" });

    const calls = wb.contents.flatMap((c) => c.parts.filter((p) => p.functionCall).map((p) => p.functionCall));
    expect(calls.map((c) => c.id)).toEqual(["call.1", "call1", "c-miss"]);
    const resps = wb.contents.flatMap((c) => c.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse));
    expect(resps.map((r) => [r.id, r.name])).toEqual([["call1", "beta"], ["call.1", "alpha"]]);
    expect(resps[0].response).toEqual({ result: ["x", "y"] });
    expect(resps[1].response).toEqual({ err: "nope" });

    expect(JSON.stringify(wb)).not.toContain("_customToolNames");
    await result.response.text();
  });

  it.each([["JSON", false], ["SSE", true]])("adapts responseJsonSchema to the aistudio responseFormat wire (%s)", async (_label, stream) => {
    const schema = { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false };
    network.mockImplementation(async () => stream
      ? new Response(`data: ${JSON.stringify(reply)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
      : Response.json(structuredClone(reply)));
    const result = await runChat(stream, { response_format: { type: "json_schema", json_schema: { name: "s", schema } } });
    expect(result.success).toBe(true);
    const gc = wireBody().generationConfig;
    if (provider === "aistudio") {
      expect(gc.responseFormat).toEqual({ text: { mimeType: "APPLICATION_JSON", schema } });
      expect(gc.responseJsonSchema).toBeUndefined();
      expect(gc.responseMimeType).toBeUndefined();
    } else {
      expect(gc.responseJsonSchema).toEqual(schema);
      expect(gc.responseMimeType).toBe("application/json");
    }
    await result.response.text();
  });

  it("surfaces the provider's native error shape instead of fabricating success", async () => {
    network.mockImplementation(async () => new Response(
      JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "fixture native invalid argument" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }));
    const result = await runChat(false);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toContain("fixture native invalid argument");
    expect(network.mock.calls).toHaveLength(1);
  });
});

describe("Responses custom tools through the chat core to a Gemini wire", () => {
  const quiet = Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine"].map((n) => [n, vi.fn()]));
  const replyWithCalls = {
    candidates: [{ index: 0, content: { role: "model", parts: [
      { functionCall: { name: "exec", args: { input: "opaque" } } },
      { functionCall: { name: "plain", args: { x: 1 } } },
    ] }, finishReason: "STOP" }],
  };

  beforeEach(() => {
    network.mockReset();
  });

  function coreArgs(stream = true) {
    return {
      body: {
        model: `gemini/${MODEL}`,
        stream,
        input: [
          { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec", format: { syntax: "lark" } }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        ],
        tools: [{ type: "function", name: "plain", description: "d", parameters: { type: "object", properties: { x: { type: "number" } } } }],
      },
      modelInfo: { provider: "gemini", model: MODEL },
      credentials: { apiKey: "offline-key", connectionId: "offline-contract" },
      log: quiet,
      clientRawRequest: { endpoint: "/v1/responses", body: {}, headers: {} },
      connectionId: "offline-contract",
      rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    };
  }

  it("JSON: exec lands as custom_tool_call with input, plain as function_call with identity", async () => {
    network.mockImplementation(async () => Response.json(structuredClone(replyWithCalls)));
    const result = await handleChatCore(coreArgs(false));
    expect(result.success).toBe(true);

    const wire = JSON.parse(network.mock.calls.at(-1)[1].body);
    const names = wire.tools[0].functionDeclarations.map((d) => d.name);
    expect(names).toContain("exec");
    expect(names).toContain("plain");
    expect(JSON.stringify(wire)).not.toContain("_customToolNames");

    const data = await result.response.json();
    const custom = data.output.find((i) => i.type === "custom_tool_call");
    expect(custom).toMatchObject({ name: "exec", input: "opaque" });
    const fn = data.output.find((i) => i.type === "function_call");
    expect(fn).toMatchObject({ name: "plain" });
    expect(fn.call_id).toBeTruthy();
    expect(JSON.parse(fn.arguments)).toEqual({ x: 1 });
  });

  it("SSE: custom_tool_call and function_call items stream back", async () => {
    const sse = `data: ${JSON.stringify(replyWithCalls)}\n\ndata: [DONE]\n\n`;
    network.mockImplementation(async () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }));
    const result = await handleChatCore(coreArgs());
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain("custom_tool_call");
    expect(text).toContain("exec");
    expect(text).toContain("opaque");
    expect(text).toContain("function_call");
    expect(text).toContain("plain");
  });
});
