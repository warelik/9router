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
import { cloakMuseTools } from "../../open-sse/utils/museCloaking.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

const MODEL = "muse-wonder-1.0-contributor";
const OAUTH = { accessToken: "test-only-muse-oauth" };

function nativeRequest() {
  return {
    model: MODEL,
    input: [
      { type: "function_call", id: "fc_history", call_id: "call_history", name: "read_file", arguments: '{"Path":"before.txt"}' },
      { type: "function_call_output", call_id: "call_history", output: "previous result" },
    ],
    tools: [
      { type: "function", name: "read_file", description: "client schema", parameters: { type: "object", properties: {} } },
      { type: "custom", name: "exec", description: "client custom tool" },
      { type: "web_search" },
      { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "read_file" }] },
    ],
    tool_choice: { type: "function", name: "read_file" },
  };
}

function derive() {
  const result = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, MODEL, nativeRequest(), true, OAUTH, "muse");
  return { upstreamRequest: result, toolNameMap: result._toolNameMap };
}

const upstreamName = (map, original) => [...map].find(([, name]) => name === original)?.[0];
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const parseEvents = wire => wire.split("\n")
  .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
  .map(line => JSON.parse(line.slice(6)));

describe("Muse Code request cloaking", () => {
  it("renames Responses declarations, history and forced choice without changing hosted tools or call identity", () => {
    const original = nativeRequest();
    const snapshot = structuredClone(original);
    const { upstreamRequest, toolNameMap } = derive();
    const readAlias = upstreamName(toolNameMap, "read_file");

    expect(readAlias).toBe("read_file_muse");
    expect(upstreamRequest.tools[0]).toMatchObject({ type: "function", name: readAlias, description: "client schema" });
    expect(upstreamRequest.tools[1].name).toBe("exec_muse");
    expect(upstreamRequest.tools[2]).toEqual({ type: "web_search" });
    expect(upstreamRequest.tools[3]).toEqual(original.tools[3]);
    expect(upstreamRequest.input[0]).toMatchObject({ type: "function_call", call_id: "call_history", name: readAlias });
    expect(upstreamRequest.input[1]).toEqual(original.input[1]);
    expect(upstreamRequest.tool_choice).toEqual({ type: "function", name: readAlias });
    expect(original).toEqual(snapshot);
  });

  it("keeps pay-as-you-go API-key declarations uncloaked", () => {
    const result = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      MODEL,
      nativeRequest(),
      true,
      { apiKey: "test-only-payg-key" },
      "muse",
    );
    expect(result.tools.map(tool => tool.name)).toEqual(nativeRequest().tools.map(tool => tool.name));
    expect(result.input[0].name).toBe("read_file");
    expect(result._toolNameMap).toBeUndefined();
  });

  it("allocates unique bounded aliases and rewrites allowed_tools without mutating hosted entries", () => {
    const longName = "x".repeat(64);
    const { body, toolNameMap } = cloakMuseTools({
      tools: [
        { type: "function", name: "read_file" },
        { type: "function", name: "read_file_muse" },
        { type: "function", name: longName },
        { type: "web_search" },
      ],
      tool_choice: {
        type: "allowed_tools",
        tools: [{ type: "function", name: "read_file" }, { type: "web_search" }],
      },
    });
    const aliases = body.tools.slice(0, 3).map(tool => tool.name);

    expect(new Set(aliases).size).toBe(3);
    expect(aliases.every(name => name.length <= 64)).toBe(true);
    expect(aliases).not.toContain("read_file");
    expect(aliases).not.toContain("read_file_muse");
    expect(aliases).not.toContain(longName);
    expect(toolNameMap.size).toBe(3);
    expect(body.tools[3]).toEqual({ type: "web_search" });
    expect(body.tool_choice.tools[0].name).toBe(aliases[0]);
    expect(body.tool_choice.tools[1]).toEqual({ type: "web_search" });
  });
});

function providerBody(toolNameMap) {
  return {
    id: "resp_muse_nonstream",
    object: "response",
    status: "completed",
    output: [{
      type: "function_call",
      id: "fc_nonstream",
      call_id: "call_nonstream",
      name: upstreamName(toolNameMap, "read_file"),
      arguments: '{"Path":"now.txt"}',
    }],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  };
}

describe("Muse Code non-streaming decloaking", () => {
  it("restores a native Responses call without changing call id or arguments", async () => {
    const { toolNameMap } = derive();
    const upstream = providerBody(toolNameMap);
    const result = await handleNonStreamingResponse({
      providerResponse: new Response(JSON.stringify(upstream), { status: 200, headers: { "content-type": "application/json" } }),
      provider: "muse",
      model: MODEL,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      body: nativeRequest(),
      stream: false,
      requestStartTime: Date.now(),
      toolNameMap,
      reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
      trackDone() {},
      appendLog() {},
    });
    const body = await result.response.json();
    const call = body.output[0];

    expect(call.name).toBe("read_file");
    expect(call.call_id).toBe("call_nonstream");
    expect(call.arguments).toBe('{"Path":"now.txt"}');
  });

  it("restores a Chat call when the client requested JSON but upstream used SSE", async () => {
    const { toolNameMap } = derive();
    const item = providerBody(toolNameMap).output[0];
    const events = [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 7, output_tokens: 3 } } },
    ];
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } }),
      provider: "muse",
      model: MODEL,
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      body: nativeRequest(),
      stream: false,
      requestStartTime: Date.now(),
      toolNameMap,
      trackDone() {},
      appendLog() {},
    });
    const body = await result.response.json();
    const call = body.choices[0].message.tool_calls[0];

    expect(call.function.name).toBe("read_file");
    expect(call.id).toBe("call_nonstream");
    expect(call.function.arguments).toBe('{"Path":"now.txt"}');
  });
});

function streamEvents(toolNameMap) {
  const name = upstreamName(toolNameMap, "read_file");
  const item = { type: "function_call", id: "fc_stream", call_id: "call_stream", name, arguments: '{"Path":"stream.txt"}' };
  return [
    { type: "response.created", response: { id: "resp_muse_stream", object: "response", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_muse_stream",
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      },
    },
  ];
}

async function runStream(sourceFormat, fragmented) {
  const { toolNameMap } = derive();
  const events = streamEvents(toolNameMap);
  const bytes = new TextEncoder().encode(events.map(frame).join(""));
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
    sourceFormat,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    body: nativeRequest(),
    stream: true,
    requestStartTime: Date.now(),
    toolNameMap,
    streamController: createStreamController({ provider: "muse", model: MODEL }),
  });
  return { raw: await result.response.text(), events, toolNameMap };
}

describe("Muse Code streaming decloaking", () => {
  it.each([false, true])("restores every Responses tool item on the passthrough path (fragmented=%s)", async fragmented => {
    const { raw, events, toolNameMap } = await runStream(FORMATS.OPENAI_RESPONSES, fragmented);
    const output = parseEvents(raw);
    const names = output.flatMap(event => [
      ...(event.item?.type === "function_call" ? [event.item.name] : []),
      ...(event.response?.output || []).filter(item => item.type === "function_call").map(item => item.name),
    ]);

    expect(names).toEqual(["read_file", "read_file", "read_file"]);
    expect(output.find(event => event.type === "response.completed").response.output[0]).toMatchObject({
      call_id: "call_stream",
      arguments: '{"Path":"stream.txt"}',
    });
    expect(raw).not.toContain(upstreamName(toolNameMap, "read_file"));
    expect(events).toEqual(streamEvents(toolNameMap));
  });

  it.each([false, true])("restores translated Chat tool calls (fragmented=%s)", async fragmented => {
    const { raw, toolNameMap } = await runStream(FORMATS.OPENAI, fragmented);
    const output = parseEvents(raw);
    const calls = output.flatMap(event => event.choices || []).flatMap(choice => [
      ...(choice.delta?.tool_calls || []),
      ...(choice.message?.tool_calls || []),
    ]);
    const named = calls.filter(call => call.function?.name);

    expect(named.length).toBeGreaterThan(0);
    expect(named.every(call => call.function.name === "read_file")).toBe(true);
    expect(calls[0].id).toBe("call_stream");
    expect(raw).not.toContain(upstreamName(toolNameMap, "read_file"));
  });
});
