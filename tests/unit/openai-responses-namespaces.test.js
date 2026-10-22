import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { RESPONSES_ITEM } from "../../open-sse/translator/schema/index.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { restoreToolNames } from "../../open-sse/utils/opencodeFingerprint.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { filterUsageForFormat } from "../../open-sse/utils/usageTracking.js";
import { preparePortableCollaboration } from "../../open-sse/translator/concerns/portableCollaboration.js";

const schema = { type: "object", properties: { title: { type: "string" }, count: { type: "integer" } }, required: ["title", "count"], additionalProperties: false };
const leaf = () => ({ type: "function", name: "read", description: "Read the selected record.", parameters: schema });
const fixture = () => ({
  model: "gemini-3.8-flash",
  tools: [
    leaf(),
    { type: "namespace", name: "alpha", description: "First source.", tools: [leaf(), { type: "custom", name: "patch", description: "Apply raw input.", format: { type: "grammar", syntax: "lark", definition: "start: TEXT" } }] },
  ],
  input: [
    { type: RESPONSES_ITEM.ADDITIONAL_TOOLS, tools: [{ type: "namespace", name: "beta", tools: [leaf()] }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Read alpha, not beta." }] },
    { type: "function_call", name: "read", namespace: "alpha", call_id: "call_alpha", arguments: '{"title":"record","count":3}' },
    { type: "function_call_output", call_id: "call_alpha", output: '{"value":"actual"}' },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
  ],
  tool_choice: { type: "function", name: "read", namespace: "beta" },
});
const alias = (map, namespace, name) => [...map].find(([, value]) => value && typeof value === "object" && value.namespace === namespace && value.name === name)?.[0];
const typedAlias = (map, namespace, name, type) => [...map].find(([, value]) => value && typeof value === "object" && value.namespace === namespace && value.name === name && value.type === type)?.[0];

it("expands namespace declarations without conflating root or equal leaf names", () => {
  const body = fixture();
  const translated = openaiResponsesToOpenAIRequest(body.model, body, true, {});
  expect(translated.tools).toHaveLength(4);
  const alpha = alias(translated._toolNameMap, "alpha", "read");
  const beta = alias(translated._toolNameMap, "beta", "read");
  expect(alpha).toBeTruthy();
  expect(beta).toBeTruthy();
  expect(alpha).not.toBe(beta);
  expect(translated.tools.map(tool => tool.function.name)).toContain("read");
  expect(new Set(translated.tools.map(tool => tool.function.name)).size).toBe(4);
  for (const name of [alpha, beta]) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  expect(translated.tools.find(tool => tool.function.name === alpha).function.parameters).toEqual(schema);
  expect(translated.messages.find(message => message.tool_calls)?.tool_calls[0]).toMatchObject({ id: "call_alpha", function: { name: alpha, arguments: '{"title":"record","count":3}' } });
  expect(translated.messages.find(message => message.role === "tool")).toMatchObject({ tool_call_id: "call_alpha", content: '{"value":"actual"}' });
  expect(translated.tool_choice).toEqual({ type: "function", function: { name: beta } });
  const repeated = openaiResponsesToOpenAIRequest(body.model, fixture(), true, {});
  expect(alias(repeated._toolNameMap, "alpha", "read")).toBe(alpha);
  const historyOnly = openaiResponsesToOpenAIRequest(body.model, { input: body.input.filter(item => item.type !== RESPONSES_ITEM.ADDITIONAL_TOOLS) }, true, {});
  expect(historyOnly.messages.find(message => message.tool_calls).tool_calls[0].function.name).toBe(alpha);
});

it("keeps same-name namespaced function and custom tools distinct through request mapping and restoration", () => {
  const makeBody = type => ({
    model: "m",
    tools: [{ type: "namespace", name: "automation", tools: [
      { type: "function", name: "run", parameters: schema },
      { type: "custom", name: "run", format: { type: "text" } },
    ] }],
    input: [
      { type: "function_call", name: "run", namespace: "automation", call_id: "call_function", arguments: '{"title":"record","count":3}' },
      { type: "custom_tool_call", name: "run", namespace: "automation", call_id: "call_custom", input: "RAW_INPUT" },
    ],
    tool_choice: { type, name: "run", namespace: "automation" },
  });
  const translated = openaiResponsesToOpenAIRequest("m", makeBody("custom"), true, {});
  const functionAlias = typedAlias(translated._toolNameMap, "automation", "run", "function");
  const customAlias = typedAlias(translated._toolNameMap, "automation", "run", "custom");

  expect(functionAlias).toBeTruthy();
  expect(customAlias).toBeTruthy();
  expect(functionAlias).not.toBe(customAlias);
  expect(translated.tools.map(tool => tool.function.name)).toEqual([functionAlias, customAlias]);
  expect(translated._toolNameMap.get(functionAlias)).toEqual({ name: "run", namespace: "automation", type: "function" });
  expect(translated._toolNameMap.get(customAlias)).toEqual({ name: "run", namespace: "automation", type: "custom", format: { type: "text" } });
  expect(translated.messages[0].tool_calls.map(call => call.function.name)).toEqual([functionAlias, customAlias]);
  expect(translated.tool_choice).toEqual({ type: "function", function: { name: customAlias } });
  expect(translated._customToolNames).toContain(customAlias);
  expect(translated._customToolNames).not.toContain(functionAlias);
  expect(restoreToolNames({ type: "function_call", name: functionAlias, call_id: "call_function", arguments: "{}" }, translated._toolNameMap)).toEqual({
    type: "function_call", name: "run", namespace: "automation", call_id: "call_function", arguments: "{}",
  });
  expect(restoreToolNames({ type: "function_call", name: customAlias, call_id: "call_custom", arguments: "RAW_INPUT" }, translated._toolNameMap)).toEqual({
    type: "custom_tool_call", name: "run", namespace: "automation", call_id: "call_custom", input: "RAW_INPUT",
  });

  const functionChoice = openaiResponsesToOpenAIRequest("m", makeBody("function"), true, {});
  expect(functionChoice.tool_choice).toEqual({ type: "function", function: { name: typedAlias(functionChoice._toolNameMap, "automation", "run", "function") } });
});

it("restores namespace identity after a chained rename in event and terminal output", () => {
  const map = new Map([["provider_name", "wire_name"], ["wire_name", { name: "read", namespace: "alpha", type: "function" }]]);
  const item = { type: "function_call", name: "provider_name", call_id: "call_1", arguments: "{}" };
  const payload = { event: "response.output_item.done", data: { type: "response.output_item.done", item, response: { output: [item] } } };
  const restored = restoreToolNames(payload, map);
  expect(restored.data.item).toMatchObject({ name: "read", namespace: "alpha", call_id: "call_1", arguments: "{}" });
  expect(restored.data.response.output[0]).toMatchObject({ name: "read", namespace: "alpha" });
  expect(payload.data.item.name).toBe("provider_name");
  expect(restoreToolNames({ type: "function_call", name: "wire_name" }, map)).toMatchObject({ name: "read", namespace: "alpha" });
});

it("restores custom response call identity from its descriptor", () => {
  const map = new Map([["wire_patch", { name: "patch", namespace: "alpha", type: "custom" }]]);
  const item = { type: "function_call", name: "wire_patch", call_id: "call_1", arguments: "RAW_PATCH" };
  const direct = restoreToolNames(item, map);
  expect(direct).toEqual({ type: "custom_tool_call", name: "patch", namespace: "alpha", call_id: "call_1", input: "RAW_PATCH" });

  const event = restoreToolNames({
    type: "response.output_item.done",
    item,
    response: { output: [item] },
  }, map);
  expect(event.item).toEqual(direct);
  expect(event.response.output[0]).toEqual(direct);
  expect(item).toEqual({ type: "function_call", name: "wire_patch", call_id: "call_1", arguments: "RAW_PATCH" });
});

for (const [format, provider] of [[FORMATS.GEMINI, "gemini"], [FORMATS.GEMINI, "aistudio"], [FORMATS.ANTIGRAVITY, "antigravity"]]) {
  describe(`${provider} namespace SSE roundtrip`, () => {
    for (const [name, type, args] of [["read", "function_call", { title: "record", count: 3 }], ["patch", "custom_tool_call", { input: "RAW_PATCH" }]]) {
      it(`retains the namespace and ${type} identity`, async () => {
        const translated = translateRequest(FORMATS.OPENAI_RESPONSES, format, "gemini-3.8-flash", fixture(), true, { projectId: "fixture" }, provider);
        const wireName = alias(translated._toolNameMap, "alpha", name);
        expect(wireName).toBeTruthy();
        const native = { candidates: [{ content: { parts: [{ functionCall: { id: "call_wire", name: wireName, args } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 10, totalTokenCount: 100 } };
        const chunk = format === FORMATS.ANTIGRAVITY ? { response: native } : native;
        const input = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)); controller.close(); } });
        const transform = createSSETransformStreamWithLogger(format, FORMATS.OPENAI_RESPONSES, provider, null, translated._toolNameMap, "gemini-3.8-flash", null, null, null, null, translated._customToolNames);
        const raw = await new Response(input.pipeThrough(transform)).text();
        const events = raw.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const done = events.find(event => event.type === "response.output_item.done");
        expect(done.item).toMatchObject({ type, name, namespace: "alpha", call_id: "call_wire" });
        if (type === "custom_tool_call") expect(done.item.input).toBe("RAW_PATCH");
        else expect(JSON.parse(done.item.arguments)).toEqual(args);
        const terminal = events.find(event => event.type === "response.completed");
        expect(terminal.response.output[0]).toMatchObject({ type, name, namespace: "alpha", call_id: "call_wire" });
      });
    }
  });
}

it("restores are idempotent: an already-projected item keeps leaf and namespace", () => {
  const map = new Map([
    ["wire", { name: "read", namespace: "alpha", type: "function" }],
    ["read", "Read"],
  ]);
  const once = restoreToolNames({ type: "function_call", name: "wire", call_id: "c1", arguments: "{}" }, map);
  expect(once).toMatchObject({ name: "read", namespace: "alpha" });
  const twice = restoreToolNames(once, map);
  expect(twice).toMatchObject({ name: "read", namespace: "alpha" });
  const viaEvent = restoreToolNames({
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      item: { type: "function_call", name: "wire" },
      response: { output: [{ type: "function_call", name: "wire" }] },
    },
  }, map);
  expect(viaEvent.data.item).toMatchObject({ name: "read", namespace: "alpha" });
  expect(viaEvent.data.response.output[0]).toMatchObject({ name: "read", namespace: "alpha" });
  const twiceEvent = restoreToolNames(viaEvent, map);
  expect(twiceEvent.data.item).toMatchObject({ name: "read", namespace: "alpha" });
  expect(twiceEvent.data.response.output[0]).toMatchObject({ name: "read", namespace: "alpha" });
});

it("keeps namespace/leaf meaning in descriptions and custom grammar hints", () => {
  const translated = openaiResponsesToOpenAIRequest("gemini-3.8-flash", fixture(), true, {});
  const alphaAlias = alias(translated._toolNameMap, "alpha", "read");
  const patchAlias = alias(translated._toolNameMap, "alpha", "patch");
  const decl = translated.tools.find(t => t.function.name === alphaAlias);
  expect(decl.function.description).toContain("[alpha.read]");
  expect(decl.function.description).toContain("Read the selected record.");
  expect(decl.function.description).toContain("First source.");
  const patchDecl = translated.tools.find(t => t.function.name === patchAlias);
  expect(patchDecl.function.description).toContain("Apply raw input.");
  expect(patchDecl.function.description).toContain("lark");
  expect(patchDecl.function.description).toContain("start: TEXT");
  expect(translated._customToolNames).toContain(patchAlias);
});

for (const [target, provider, credentials] of [
  [FORMATS.OPENAI, "openai", null],
  [FORMATS.CLAUDE, "anthropic", { apiKey: "fixture-key" }],
  [FORMATS.KIRO, "kiro", {}],
]) {
  it(`survives target ${target}: namespace descriptors remain in the translated map`, () => {
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, target, "gemini-3.8-flash", fixture(), true, credentials, provider);
    expect(translated._toolNameMap instanceof Map).toBe(true);
    const alphaAlias = alias(translated._toolNameMap, "alpha", "read");
    const betaAlias = alias(translated._toolNameMap, "beta", "read");
    expect(alphaAlias).toBeTruthy();
    expect(betaAlias).toBeTruthy();
    expect(translated._toolNameMap.get(alphaAlias)).toEqual({ name: "read", namespace: "alpha", type: "function" });
  });
}

it("reserves root names before aliasing: a root tool named like a base alias wins deterministically", () => {
  const baseline = openaiResponsesToOpenAIRequest("gemini-3.8-flash", fixture(), true, {});
  const baseAlias = alias(baseline._toolNameMap, "alpha", "read");
  const imposter = { type: "function", name: baseAlias, description: "Imposter root tool.", parameters: schema };
  const nsAlpha = () => ({ type: "namespace", name: "alpha", tools: [leaf(), { type: "custom", name: "patch", description: "Apply raw input.", format: { type: "grammar", syntax: "lark", definition: "start: TEXT" } }] });
  const orderA = fixture();
  orderA.tools = [leaf(), imposter, nsAlpha()];
  const orderB = fixture();
  orderB.tools = [nsAlpha(), leaf(), imposter];
  const translatedA = openaiResponsesToOpenAIRequest("gemini-3.8-flash", orderA, true, {});
  const translatedB = openaiResponsesToOpenAIRequest("gemini-3.8-flash", orderB, true, {});
  const aliasA = alias(translatedA._toolNameMap, "alpha", "read");
  const aliasB = alias(translatedB._toolNameMap, "alpha", "read");
  expect(aliasA).toBe(aliasB);
  expect(aliasA).not.toBe(baseAlias);
  expect(aliasA).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  expect(translatedA.tools.map(t => t.function.name)).toContain(baseAlias);
  expect(translatedA.messages.find(m => m.tool_calls).tool_calls[0].function.name).toBe(aliasA);
  expect(translatedA._toolNameMap.get(aliasA)).toEqual({ name: "read", namespace: "alpha", type: "function" });
});

it("ignores nested namespaces, hosted tools, and null children while keeping valid children", () => {
  const body = fixture();
  body.tools = [{
    type: "namespace", name: "gamma", tools: [
      { type: "namespace", name: "inner", tools: [leaf()] },
      { type: "request_user_input" },
      null,
      leaf(),
    ],
  }];
  const translated = openaiResponsesToOpenAIRequest(body.model, body, true, {});
  expect(translated.tools).toHaveLength(2);
  const gammaAlias = alias(translated._toolNameMap, "gamma", "read");
  const betaAlias = alias(translated._toolNameMap, "beta", "read");
  expect(gammaAlias).toBeTruthy();
  expect(betaAlias).toBeTruthy();
  expect(translated.tools.map(t => t.function.name)).toEqual(expect.arrayContaining([gammaAlias, betaAlias]));
  expect(alias(translated._toolNameMap, "inner", "read")).toBeUndefined();
});

const jsonUsageMetadata = { promptTokenCount: 90, candidatesTokenCount: 10, thoughtsTokenCount: 10, cachedContentTokenCount: 40, totalTokenCount: 110 };
const expectedJsonUsage = { input_tokens: 90, output_tokens: 20, total_tokens: 110, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 } };

for (const [format, provider] of [[FORMATS.GEMINI, "gemini"], [FORMATS.GEMINI, "aistudio"], [FORMATS.ANTIGRAVITY, "antigravity"]]) {
  describe(`${provider} namespace non-streaming JSON`, () => {
    for (const [name, type, args] of [["read", "function_call", { title: "record", count: 3 }], ["patch", "custom_tool_call", { input: "RAW_PATCH" }]]) {
      it(`retains the namespace and ${type} identity`, async () => {
        const translated = translateRequest(FORMATS.OPENAI_RESPONSES, format, "gemini-3.8-flash", fixture(), true, { projectId: "fixture" }, provider);
        const wireName = alias(translated._toolNameMap, "alpha", name);
        expect(wireName).toBeTruthy();
        const native = { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_json", name: wireName, args } }] }, finishReason: "STOP" }], usageMetadata: jsonUsageMetadata };
        const body = format === FORMATS.ANTIGRAVITY ? { response: native } : native;
        const result = translateNonStreamingResponse(body, format, FORMATS.OPENAI_RESPONSES, new Set(translated._customToolNames || []));
        const restored = restoreToolNames(result, translated._toolNameMap);
        const item = restored.output.find(i => i.type === type);
        expect(item).toMatchObject({ type, name, namespace: "alpha", call_id: "call_json" });
        if (type === "custom_tool_call") expect(item.input).toBe("RAW_PATCH");
        else expect(JSON.parse(item.arguments)).toEqual(args);
        expect(restored.usage).toEqual(expectedJsonUsage);
        expect(filterUsageForFormat(restored.usage, FORMATS.OPENAI_RESPONSES)).toEqual(expectedJsonUsage);
      });
    }
    it("keeps a generated fallback call_id when the native call omits id", () => {
      const translated = translateRequest(FORMATS.OPENAI_RESPONSES, format, "gemini-3.8-flash", fixture(), true, { projectId: "fixture" }, provider);
      const wireName = alias(translated._toolNameMap, "alpha", "read");
      const native = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: wireName, args: {} } }] }, finishReason: "STOP" }], usageMetadata: jsonUsageMetadata };
      const body = format === FORMATS.ANTIGRAVITY ? { response: native } : native;
      const restored = restoreToolNames(translateNonStreamingResponse(body, format, FORMATS.OPENAI_RESPONSES, new Set(translated._customToolNames || [])), translated._toolNameMap);
      const item = restored.output.find(i => i.type === "function_call");
      expect(typeof item.call_id).toBe("string");
      expect(item.call_id.length).toBeGreaterThan(0);
      expect(item.call_id).not.toBe("call_json");
      expect(item).toMatchObject({ name: "read", namespace: "alpha" });
    });
  });
}

const REASONING_BLOB = "gAAAAAB_reasoning_opaque_blob";
const messageSchema = { type: "object", properties: { message: { type: "string", encrypted: true, description: "Task text." }, note: { type: "string", encrypted: true } }, required: ["message"], additionalProperties: false, strict: true };
const collaborationTools = () => ({
  type: "namespace",
  name: "collaboration",
  description: "Multi-agent tools.",
  tools: [
    { type: "function", name: "spawn_agent", description: "Start a child.", parameters: messageSchema, strict: true, vendorHint: "kept" },
    { type: "function", name: "wait_agent", description: "Wait.", parameters: { type: "object", properties: { targets: { type: "array", encrypted: true } } } },
    { type: "custom", name: "send_patch", description: "Raw.", format: { type: "text" } },
  ],
});
const collaborationBody = () => ({
  model: "gpt-5.5",
  tools: [
    { type: "function", name: "read", description: "Root read.", parameters: schema },
    collaborationTools(),
    { type: "namespace", name: "alpha", tools: [leaf()] },
  ],
  input: [
    { type: RESPONSES_ITEM.ADDITIONAL_TOOLS, tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "followup_task", parameters: { type: "object", properties: { message: { type: "string", encrypted: true } } } }] }] },
    { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "call_spawn", arguments: '{"message":"Task"}' },
    { type: "function_call_output", call_id: "call_spawn", output: '{"ok":true}' },
    { type: "custom_tool_call", namespace: "collaboration", name: "send_patch", call_id: "call_patch", input: "RAW" },
    { type: "custom_tool_call_output", call_id: "call_patch", output: "done" },
    { type: "reasoning", encrypted_content: REASONING_BLOB, summary: [] },
  ],
  tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "spawn_agent", namespace: "collaboration" }] },
});

describe("portable collaboration preparation", () => {
  it("keeps same-name function and custom declarations, history, choices, and restored outputs distinct", () => {
    const body = {
      model: "m",
      tools: [{ type: "namespace", name: "collaboration", tools: [
        { type: "function", name: "run", parameters: schema },
        { type: "custom", name: "run", format: { type: "text" } },
      ] }],
      input: [
        { type: "function_call", name: "run", namespace: "collaboration", call_id: "call_function", arguments: "{}" },
        { type: "custom_tool_call", name: "run", namespace: "collaboration", call_id: "call_custom", input: "RAW_INPUT" },
      ],
      tool_choice: { type: "allowed_tools", mode: "auto", tools: [
        { type: "function", name: "run", namespace: "collaboration" },
        { type: "custom", name: "run", namespace: "collaboration" },
      ] },
    };
    const { body: out, toolNameMap } = preparePortableCollaboration(body);
    const functionAlias = typedAlias(toolNameMap, "collaboration", "run", "function");
    const customAlias = typedAlias(toolNameMap, "collaboration", "run", "custom");

    expect(functionAlias).toBeTruthy();
    expect(customAlias).toBeTruthy();
    expect(functionAlias).not.toBe(customAlias);
    expect(out.tools.map(tool => tool.name)).toEqual([functionAlias, customAlias]);
    expect(out.input.map(item => item.name)).toEqual([functionAlias, customAlias]);
    expect(out.tool_choice.tools.map(choice => choice.name)).toEqual([functionAlias, customAlias]);
    expect(toolNameMap.get(functionAlias)).toEqual({ name: "run", namespace: "collaboration", type: "function" });
    expect(toolNameMap.get(customAlias)).toEqual({ name: "run", namespace: "collaboration", type: "custom" });
    expect(restoreToolNames({ type: "function_call", name: functionAlias, call_id: "call_function", arguments: "{}" }, toolNameMap)).toEqual({
      type: "function_call", name: "run", namespace: "collaboration", call_id: "call_function", arguments: "{}",
    });
    expect(restoreToolNames({ type: "function_call", name: customAlias, call_id: "call_custom", arguments: "RAW_INPUT" }, toolNameMap)).toEqual({
      type: "custom_tool_call", name: "run", namespace: "collaboration", call_id: "call_custom", input: "RAW_INPUT",
    });
  });

  it("flattens collaboration declarations and drops encrypted only from the listed message schemas", () => {
    const body = collaborationBody();
    const before = JSON.stringify(body);
    const { body: out, toolNameMap } = preparePortableCollaboration(body);
    expect(JSON.stringify(body)).toBe(before);
    const spawn = alias(toolNameMap, "collaboration", "spawn_agent");
    const spawnTool = out.tools.find(tool => tool.name === spawn);
    expect(spawnTool.description).toBe("Multi-agent tools.\nStart a child.");
    expect(spawnTool.parameters.properties.message).toEqual({ type: "string", description: "Task text." });
    expect(spawnTool.parameters.properties.note.encrypted).toBe(true);
    expect(spawnTool).toMatchObject({ strict: true, vendorHint: "kept" });
    expect(spawnTool.parameters).toMatchObject({ additionalProperties: false, required: ["message"] });
    const waitTool = out.tools.find(tool => tool.name === alias(toolNameMap, "collaboration", "wait_agent"));
    expect(waitTool.parameters.properties.targets.encrypted).toBe(true);
    expect(toolNameMap.get(alias(toolNameMap, "collaboration", "send_patch"))).toEqual({ name: "send_patch", namespace: "collaboration", type: "custom" });
    const followup = out.input[0].tools[0];
    expect(followup.parameters.properties.message).toEqual({ type: "string" });
  });

  it("rewrites history calls and tool choices while leaving results and reasoning untouched", () => {
    const body = collaborationBody();
    const { body: out, toolNameMap } = preparePortableCollaboration(body);
    const spawn = alias(toolNameMap, "collaboration", "spawn_agent");
    const patch = alias(toolNameMap, "collaboration", "send_patch");
    expect(out.input[1]).toEqual({ type: "function_call", name: spawn, call_id: "call_spawn", arguments: '{"message":"Task"}' });
    expect(out.input[2]).toEqual(body.input[2]);
    expect(out.input[3]).toEqual({ type: "custom_tool_call", name: patch, call_id: "call_patch", input: "RAW" });
    expect(out.input[4]).toEqual(body.input[4]);
    expect(out.input[5]).toEqual(body.input[5]);
    expect(out.tool_choice.tools[0]).toEqual({ type: "function", name: spawn });
  });

  it("rewrites a direct namespaced tool_choice", () => {
    const { body: out, toolNameMap } = preparePortableCollaboration({ model: "m", tools: [collaborationTools()], tool_choice: { type: "function", name: "spawn_agent", namespace: "collaboration" } });
    expect(out.tool_choice).toEqual({ type: "function", name: alias(toolNameMap, "collaboration", "spawn_agent") });
  });

  it("keeps other namespaces and root tools unchanged", () => {
    const body = collaborationBody();
    const { body: out } = preparePortableCollaboration(body);
    expect(out.tools[0]).toEqual(body.tools[0]);
    expect(out.tools.at(-1)).toEqual(body.tools[2]);
  });

  it("resolves alias collisions with unrelated root tools deterministically", () => {
    const first = preparePortableCollaboration(collaborationBody());
    const base = alias(first.toolNameMap, "collaboration", "spawn_agent");
    const body = collaborationBody();
    body.tools.push({ type: "function", name: base, parameters: { type: "object" } });
    const { toolNameMap } = preparePortableCollaboration(body);
    expect(alias(toolNameMap, "collaboration", "spawn_agent")).toBe(`${base.slice(0, 58)}_1`);
  });

  it("restores collaboration identity in Responses SSE and terminal output while keeping the reasoning blob", async () => {
    const { toolNameMap } = preparePortableCollaboration(collaborationBody());
    const spawn = alias(toolNameMap, "collaboration", "spawn_agent");
    const reasoning = { type: "reasoning", encrypted_content: REASONING_BLOB, summary: [] };
    const call = { type: "function_call", name: spawn, call_id: "call_spawn", arguments: '{"message":"Task"}' };
    const events = [
      { type: "response.output_item.added", item: call },
      { type: "response.output_item.done", item: reasoning },
      { type: "response.output_item.done", item: call },
      { type: "response.completed", response: { output: [reasoning, call] } },
    ];
    const input = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))); controller.close(); } });
    const transform = createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex", null, toolNameMap, "gpt-5.5", null, null, null, null, null);
    const raw = await new Response(input.pipeThrough(transform)).text();
    const out = raw.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const added = out.find(event => event.type === "response.output_item.added");
    expect(added.item).toMatchObject({ name: "spawn_agent", namespace: "collaboration", call_id: "call_spawn" });
    const done = out.filter(event => event.type === "response.output_item.done");
    expect(done.find(event => event.item.type === "function_call").item).toMatchObject({ name: "spawn_agent", namespace: "collaboration", call_id: "call_spawn", arguments: '{"message":"Task"}' });
    expect(done.find(event => event.item.type === "reasoning").item).toEqual(reasoning);
    const terminal = out.find(event => event.type === "response.completed");
    expect(terminal.response.output[0]).toEqual(reasoning);
    expect(terminal.response.output[1]).toMatchObject({ name: "spawn_agent", namespace: "collaboration", call_id: "call_spawn" });
  });

  it.each(["spawn_agent", "send_message", "followup_task"])("removes encrypted only from %s message schema", tool => {
    const reasoning = { type: "reasoning", encrypted_content: REASONING_BLOB, summary: [] };
    const body = {
      model: "gpt-5.5",
      tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: tool, parameters: messageSchema }] }],
      input: [reasoning],
    };
    const { body: out, toolNameMap } = preparePortableCollaboration(body);
    const flat = out.tools.find(item => item.name === alias(toolNameMap, "collaboration", tool));
    expect(flat.parameters.properties.message).toEqual({ type: "string", description: "Task text." });
    expect(flat.parameters.properties.note).toEqual({ type: "string", encrypted: true });
    expect(out.input[0]).toEqual(reasoning);
  });

  it("restores terminal non-streaming output and keeps reasoning identical", () => {
    const { toolNameMap } = preparePortableCollaboration(collaborationBody());
    const spawn = alias(toolNameMap, "collaboration", "spawn_agent");
    const reasoning = { type: "reasoning", encrypted_content: REASONING_BLOB, summary: [] };
    const restored = restoreToolNames({ type: "response", output: [reasoning, { type: "function_call", name: spawn, call_id: "call_spawn", arguments: "{}" }] }, toolNameMap);
    expect(restored.output[0]).toEqual(reasoning);
    expect(restored.output[1]).toMatchObject({ name: "spawn_agent", namespace: "collaboration" });
  });
});
