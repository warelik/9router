/**
 * Meta's Responses executor rejects two shapes Codex sends for every model
 * whose catalog entry is inherited from an OpenAI model:
 *   - `{"type":"web_search","search_content_types":["text","image"]}`
 *     → 400 "`tools[].search_content_types` is only supported for
 *       web_search_preview tools" (and web_search_preview with the field is
 *       rejected too: "not supported by the current Responses web_search
 *       executor"); a bare web_search tool is accepted.
 *   - the freeform `{"type":"custom","name":"apply_patch",...}` tool
 *     → 400 "`custom` tools are not supported on this endpoint".
 *
 * The Muse lane therefore strips search_content_types and sends custom
 * tools as functions with one raw `input` string (the Responses→Chat
 * shape), converting the calls back to custom_tool_call on every response
 * path: non-streaming JSON, forced SSE→JSON, and the passthrough stream
 * Codex actually consumes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  saveUsageStats: vi.fn(),
}));
vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }),
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", async importOriginal => ({
  ...await importOriginal(),
  buildRequestDetail: () => ({}),
  extractRequestConfig: (body, stream) => ({ body, stream }),
  saveUsageStats: () => {},
  formatDoneLine: () => "",
}));

import "../translator/registerAll.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { normalizeMuseResponsesTools } from "../../open-sse/utils/museCloaking.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

const MODEL = "muse-wonder-full-1.0-contributor";
const OAUTH = { accessToken: "test-only-muse-oauth" };
const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
const PATCH_ARGS = JSON.stringify({ input: PATCH });

function codexRequest() {
  return {
    model: MODEL,
    input: [
      {
        type: "additional_tools",
        tools: [
          { type: "custom", name: "deferred_patch" },
          { type: "web_search", search_content_types: ["text", "image"] },
        ],
      },
      { type: "custom_tool_call", call_id: "call_prev", name: "apply_patch", input: PATCH },
      { type: "custom_tool_call_output", call_id: "call_prev", output: "patched" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
    ],
    tools: [
      { type: "function", name: "read_file", description: "read", strict: false, parameters: { type: "object", properties: {} } },
      {
        type: "custom", name: "apply_patch", description: "edit files",
        format: { type: "grammar", syntax: "lark", definition: "start: begin_patch" },
      },
      { type: "web_search", external_web_access: true, search_content_types: ["text", "image"] },
      { type: "web_search_preview", search_content_types: ["text"] },
      {
        type: "namespace", name: "collaboration", description: "sub-agents",
        tools: [
          { type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } },
          { type: "custom", name: "send_patch", description: "raw patch" },
        ],
      },
    ],
    tool_choice: { type: "custom", name: "apply_patch" },
  };
}

function derive(credentials = OAUTH) {
  const result = translateRequest(
    FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, MODEL, codexRequest(), true, credentials, "muse",
  );
  return {
    upstreamRequest: result,
    toolNameMap: result._toolNameMap,
    customToolNames: new Set(result._customToolNames || []),
  };
}

describe("Muse request tool normalization", () => {
  it("does not mutate the caller's body", () => {
    const request = codexRequest();
    const snapshot = structuredClone(request);
    const { body } = normalizeMuseResponsesTools(request);
    expect(body).not.toBe(request);
    expect(request).toEqual(snapshot);
  });

  it("strips search_content_types everywhere and rewrites custom tools as functions", () => {
    const { upstreamRequest, customToolNames, toolNameMap } = derive();

    expect(JSON.stringify(upstreamRequest)).not.toContain("search_content_types");
    expect(upstreamRequest.tools[2]).toEqual({ type: "web_search", external_web_access: true });
    expect(upstreamRequest.tools[3]).toEqual({ type: "web_search_preview" });

    const patch = upstreamRequest.tools[1];
    expect(patch.type).toBe("function");
    expect(patch.name).toBe("apply_patch_muse");
    expect(patch.description).toContain("edit files");
    expect(patch.description).toContain("start: begin_patch");
    expect(patch.parameters).toEqual({
      type: "object",
      properties: { input: { type: "string", description: "Raw freeform input for this custom tool" } },
      required: ["input"],
      additionalProperties: false,
    });
    expect(patch.format).toBeUndefined();

    const namespace = upstreamRequest.tools[4];
    expect(namespace.tools[0]).toMatchObject({ type: "function", name: "spawn_agent" });
    expect(namespace.tools[1]).toMatchObject({ type: "function", name: "send_patch" });

    const deferred = upstreamRequest.input[0];
    // Cloaking renames body.tools only; deferred declarations keep their name.
    expect(deferred.tools[0]).toMatchObject({ type: "function", name: "deferred_patch" });
    expect(deferred.tools[1]).toEqual({ type: "web_search" });

    expect(upstreamRequest.input[1]).toEqual({
      type: "function_call", call_id: "call_prev", name: "apply_patch_muse", arguments: PATCH_ARGS,
    });
    expect(upstreamRequest.input[2]).toEqual({
      type: "function_call_output", call_id: "call_prev", output: "patched",
    });
    expect(upstreamRequest.tool_choice).toEqual({ type: "function", name: "apply_patch_muse" });

    expect(customToolNames).toContain("apply_patch_muse");
    expect(customToolNames).toContain("deferred_patch");
    expect(customToolNames).toContain("collaboration/send_patch");

    // Meta flattens namespace calls in its replies; the descriptors are
    // what the response restorers split them back with.
    expect(toolNameMap.get("collaboration.spawn_agent")).toEqual({
      name: "spawn_agent", namespace: "collaboration", type: "function",
    });
    expect(toolNameMap.get("collaboration.send_patch")).toEqual({
      name: "send_patch", namespace: "collaboration", type: "custom",
    });
  });

  it("normalizes pay-as-you-go requests without cloaking their names", () => {
    const { upstreamRequest, customToolNames } = derive({ apiKey: "test-only-payg-key" });
    expect(upstreamRequest.tools[1]).toMatchObject({ type: "function", name: "apply_patch" });
    expect(upstreamRequest.input[1].name).toBe("apply_patch");
    expect(JSON.stringify(upstreamRequest)).not.toContain("search_content_types");
    expect(customToolNames).toContain("apply_patch");
  });
});

function providerItem(name, args = PATCH_ARGS) {
  return { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: args };
}

describe("Muse custom tool restore (non-streaming)", () => {
  it("returns a custom_tool_call with the unwrapped raw input", async () => {
    const { toolNameMap, customToolNames } = derive();
    const result = await handleNonStreamingResponse({
      providerResponse: new Response(JSON.stringify({
        id: "resp_1", object: "response", status: "completed",
        output: [providerItem("apply_patch_muse")],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      provider: "muse",
      model: MODEL,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      body: codexRequest(),
      stream: false,
      requestStartTime: Date.now(),
      toolNameMap,
      customToolNames,
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
      trackDone() {},
      appendLog() {},
    });
    const body = await result.response.json();
    expect(body.output[0]).toEqual({
      type: "custom_tool_call", id: "fc_1", call_id: "call_1", name: "apply_patch", input: PATCH,
    });
  });

  it("splits Meta's flattened namespace calls back into name + namespace", async () => {
    const { toolNameMap, customToolNames } = derive();
    const result = await handleNonStreamingResponse({
      providerResponse: new Response(JSON.stringify({
        id: "resp_2", object: "response", status: "completed",
        output: [
          { type: "function_call", id: "fc_2", call_id: "call_2", name: "collaboration.spawn_agent", arguments: '{"message":"hi"}' },
          { type: "function_call", id: "fc_3", call_id: "call_3", name: "collaboration.send_patch", arguments: PATCH_ARGS },
        ],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      provider: "muse",
      model: MODEL,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      body: codexRequest(),
      stream: false,
      requestStartTime: Date.now(),
      toolNameMap,
      customToolNames,
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
      trackDone() {},
      appendLog() {},
    });
    const body = await result.response.json();
    expect(body.output[0]).toEqual({
      type: "function_call", id: "fc_2", call_id: "call_2",
      name: "spawn_agent", namespace: "collaboration", arguments: '{"message":"hi"}',
    });
    expect(body.output[1]).toEqual({
      type: "custom_tool_call", id: "fc_3", call_id: "call_3",
      name: "send_patch", namespace: "collaboration", input: PATCH,
    });
  });
});

const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const parseEvents = wire => wire.split("\n")
  .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
  .map(line => JSON.parse(line.slice(6)));

function customStreamEvents() {
  const item = providerItem("apply_patch_muse");
  const fnItem = { type: "function_call", id: "fc_2", call_id: "call_2", name: "read_file_muse", arguments: '{"Path":"x"}' };
  const nsItem = { type: "function_call", id: "fc_3", call_id: "call_3", name: "collaboration.spawn_agent", arguments: '{"message":"hi"}' };
  return [
    { type: "response.created", sequence_number: 0, response: { id: "resp_s", object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", sequence_number: 2, item_id: "fc_1", output_index: 0, delta: PATCH_ARGS.slice(0, 12) },
    { type: "response.function_call_arguments.delta", sequence_number: 3, item_id: "fc_1", output_index: 0, delta: PATCH_ARGS.slice(12) },
    { type: "response.function_call_arguments.done", sequence_number: 4, item_id: "fc_1", output_index: 0, arguments: PATCH_ARGS },
    { type: "response.output_item.done", sequence_number: 5, output_index: 0, item },
    { type: "response.output_item.added", sequence_number: 6, output_index: 1, item: { ...fnItem, arguments: "" } },
    { type: "response.function_call_arguments.delta", sequence_number: 7, item_id: "fc_2", output_index: 1, delta: '{"Path":"x"}' },
    { type: "response.function_call_arguments.done", sequence_number: 8, item_id: "fc_2", output_index: 1, arguments: '{"Path":"x"}' },
    { type: "response.output_item.done", sequence_number: 9, output_index: 1, item: fnItem },
    { type: "response.output_item.added", sequence_number: 10, output_index: 2, item: { ...nsItem, arguments: "" } },
    { type: "response.function_call_arguments.delta", sequence_number: 11, item_id: "fc_3", output_index: 2, delta: '{"message":"hi"}' },
    { type: "response.function_call_arguments.done", sequence_number: 12, item_id: "fc_3", output_index: 2, arguments: '{"message":"hi"}' },
    { type: "response.output_item.done", sequence_number: 13, output_index: 2, item: nsItem },
    {
      type: "response.completed", sequence_number: 14,
      response: {
        id: "resp_s", object: "response", status: "completed",
        output: [item, fnItem, nsItem],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    },
  ];
}

async function runStream(fragmented) {
  const { toolNameMap, customToolNames } = derive();
  const bytes = new TextEncoder().encode(customStreamEvents().map(frame).join(""));
  const chunks = fragmented ? [...bytes].map(byte => Uint8Array.of(byte)) : [bytes];
  const providerResponse = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
  const result = await handleStreamingResponse({
    providerResponse,
    provider: "muse",
    model: MODEL,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    body: codexRequest(),
    stream: true,
    requestStartTime: Date.now(),
    toolNameMap,
    customToolNames,
    streamController: createStreamController({ provider: "muse", model: MODEL }),
  });
  return result.response.text();
}

describe("Muse custom tool restore (streaming passthrough)", () => {
  it.each([false, true])("buffers custom argument fragments and emits custom_tool_call_input (fragmented=%s)", async fragmented => {
    const raw = await runStream(fragmented);
    const output = parseEvents(raw);

    const added = output.find(event => event.type === "response.output_item.added" && event.item?.call_id === "call_1");
    expect(added.item).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: "" });
    expect(added.item.arguments).toBeUndefined();

    const kinds = output.map(event => event.type);
    expect(kinds.filter(type => type === "response.custom_tool_call_input.delta")).toHaveLength(1);
    expect(kinds.filter(type => type === "response.custom_tool_call_input.done")).toHaveLength(1);
    expect(output.find(event => event.type === "response.custom_tool_call_input.delta")?.delta).toBe(PATCH);
    expect(output.find(event => event.type === "response.custom_tool_call_input.done")?.input).toBe(PATCH);

    // The ordinary function call beside it streams through untouched.
    const fnDeltas = output.filter(event => event.type === "response.function_call_arguments.delta");
    expect(fnDeltas.map(event => event.item_id)).toEqual(["fc_2", "fc_3"]);
    expect(raw).toContain("event: response.function_call_arguments.delta");

    // Meta's flattened namespace call is split back for the client router.
    const nsAdded = output.find(event => event.type === "response.output_item.added" && event.item?.call_id === "call_3");
    expect(nsAdded.item).toMatchObject({ type: "function_call", name: "spawn_agent", namespace: "collaboration" });

    const done = output.find(event => event.type === "response.output_item.done" && event.item?.call_id === "call_1");
    expect(done.item).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: PATCH });
    const completed = output.find(event => event.type === "response.completed");
    expect(completed.response.output[0]).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: PATCH });
    expect(completed.response.output[1]).toMatchObject({ type: "function_call", name: "read_file", arguments: '{"Path":"x"}' });
    expect(completed.response.output[2]).toMatchObject({
      type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: '{"message":"hi"}',
    });
    expect(raw).not.toContain("collaboration.spawn_agent");

    expect(raw).toContain("event: response.custom_tool_call_input.delta");
    expect(raw).toContain("event: response.custom_tool_call_input.done");
    expect(raw).not.toContain("apply_patch_muse");
    expect(raw).not.toContain("read_file_muse");
  });

  it("restores the call when a JSON client is served from the SSE stream", async () => {
    const { toolNameMap, customToolNames } = derive();
    const item = providerItem("apply_patch_muse");
    const events = [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 3 } } },
    ];
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } }),
      provider: "muse",
      model: MODEL,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      body: codexRequest(),
      stream: false,
      requestStartTime: Date.now(),
      toolNameMap,
      customToolNames,
      trackDone() {},
      appendLog() {},
    });
    const body = await result.response.json();
    expect(body.output[0]).toMatchObject({ type: "custom_tool_call", name: "apply_patch", call_id: "call_1", input: PATCH });
  });
});

describe("Muse portable Responses input (multi-agent histories)", () => {
  it("declares the strict-input quirk on the Responses transport only", async () => {
    const { resolveTransport } = await import("../../open-sse/services/provider.js");
    expect(resolveTransport("muse", "openai-responses")?.quirks?.portableResponsesInput).toBe(true);
    expect(resolveTransport("muse", "openai")?.quirks?.portableResponsesInput).toBeUndefined();
  });

  it("rewrites agent_message for Meta while keeping its native reasoning", async () => {
    const { toPortableResponsesInput } = await import("../../open-sse/translator/formats/responsesApi.js");
    const metaReasoning = {
      type: "reasoning", id: "rs_meta", status: "completed", summary: [],
      encrypted_content: "Q-PaDgFdLdBPCAXOYA7lSpfH-meta-native",
    };
    const out = toPortableResponsesInput([
      {
        type: "agent_message", author: "/root/child", recipient: "/root",
        content: [
          { type: "input_text", text: "child: done" },
          { type: "encrypted_content", encrypted_content: "gAAAAABh-codex-fernet" },
        ],
      },
      { type: "function_call_output", name: "send_message_to_thread", namespace: "codex_tui", output: "delegated" },
      metaReasoning,
    ]);
    expect(out[0]).toEqual({
      type: "message", role: "user",
      content: [{ type: "input_text", text: "child: done" }],
    });
    expect(out[1]).toEqual({
      type: "message", role: "user",
      content: [{ type: "input_text", text: "delegated" }],
    });
    expect(out[2]).toBe(metaReasoning);
  });
});
