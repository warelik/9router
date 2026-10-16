import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => { }),
  saveRequestDetail: vi.fn(async () => { }),
  saveUsageStats: vi.fn()
}));
vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => { }, remove: async () => { }, getAll: async () => ({}) })
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", async importOriginal => ({
  ...await importOriginal(),
  buildRequestDetail: () => ({}),
  saveUsageStats: () => { },
  formatDoneLine: () => ""
}));

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const clientRequest = {
  tools: [{ name: "read", input_schema: { type: "object" } }, { name: "write", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "read files" }],
  tool_choice: { type: "tool", name: "read" }
};

const derive = () => cloakClaudeTools(clientRequest);
const upstreamName = (toolNameMap, original) => [...toolNameMap].find(([, name]) => name === original)[0];
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const parseEvents = wire => wire.split("\n")
  .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
  .map(line => JSON.parse(line.slice(6)));
const isToolStart = event => event.type === "content_block_start" && event.content_block?.type === "tool_use";

const messageStart = { type: "message_start", message: { id: "msg_stream_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } };
const messageDelta = { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } };
const toolStart = (index, id, name) => ({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {}, caller: { type: "direct" } } });
const toolCall = (index, id, name, chunks) => [
  toolStart(index, id, name),
  ...chunks.map(partial_json => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
  { type: "content_block_stop", index }
];

const multiCallEvents = nameOf => [
  messageStart,
  ...toolCall(0, "toolu_read_1", nameOf("read"), ['{"path":"文', '件.txt"}']),
  ...toolCall(1, "toolu_read_2", nameOf("read"), ['{"path":"café.md"}']),
  ...toolCall(2, "toolu_write_1", nameOf("write"), ['{"path":"日本.txt"}']),
  messageDelta,
  { type: "message_stop" }
];

const richEvents = nameOf => [
  { ...messageStart, future_field: { enabled: true } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan 思考" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_opaque" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque_blob" } },
  { type: "content_block_stop", index: 1 },
  { type: "ping" },
  ...toolCall(2, "toolu_read_1", nameOf("read"), ['{"path":"文', '件.txt"}']),
  { ...messageDelta, future_usage: 1 },
  { type: "message_stop" }
];

async function runStream(wire, { toolNameMap, fragmented = false, sourceFormat = FORMATS.CLAUDE, targetFormat = FORMATS.CLAUDE, provider = "claude", body = clientRequest } = {}) {
  const bytes = new TextEncoder().encode(wire);
  const chunks = fragmented ? [...bytes].map(byte => Uint8Array.of(byte)) : [bytes];
  const providerResponse = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
  const result = await handleStreamingResponse({
    providerResponse,
    provider,
    model: "claude-opus-5-5",
    sourceFormat,
    targetFormat,
    body,
    stream: true,
    requestStartTime: Date.now(),
    toolNameMap,
    streamController: createStreamController({ provider: "claude", model: "claude-opus-5-5" })
  });
  return result.response.text();
}

describe("claude same-format stream keeps tool names and thinking signatures", () => {
  it.each([false, true])("restores each mapped tool call exactly once and rebuilds the next turn (fragmented=%s)", async fragmented => {
    const { body: upstreamRequest, toolNameMap } = derive();
    const mapBefore = new Map(toolNameMap);
    const wireEvents = multiCallEvents(name => upstreamName(toolNameMap, name));
    const expectedEvents = multiCallEvents(name => name);
    const snapshot = structuredClone(wireEvents);

    const out = parseEvents(await runStream(wireEvents.map(frame).join(""), { toolNameMap, fragmented }));

    expect(out).toEqual(expectedEvents);
    expect(out.filter(isToolStart).map(event => event.content_block.name)).toEqual(["read", "read", "write"]);
    expect(wireEvents).toEqual(snapshot);
    expect(toolNameMap).toEqual(mapBefore);

    const upstreamNames = wireEvents.filter(isToolStart).map(event => event.content_block.name);
    const advertised = new Set(upstreamRequest.tools.map(tool => tool.name));
    expect(upstreamNames.every(name => advertised.has(name))).toBe(true);

    const starts = out.filter(isToolStart);
    const inputs = {};
    for (const event of out) {
      if (event.type === "content_block_delta") inputs[event.index] = (inputs[event.index] || "") + event.delta.partial_json;
    }
    const calls = starts.map(event => ({ type: "tool_use", id: event.content_block.id, name: event.content_block.name, input: JSON.parse(inputs[event.index]) }));
    expect(calls.map(call => call.input)).toEqual([{ path: "文件.txt" }, { path: "café.md" }, { path: "日本.txt" }]);
    expect(calls.map(call => call.id)).toEqual(wireEvents.filter(isToolStart).map(event => event.content_block.id));

    const history = [
      { role: "user", content: "read files" },
      { role: "assistant", content: calls },
      { role: "user", content: calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "ok" })) }
    ];
    const second = cloakClaudeTools({ ...clientRequest, messages: history });
    expect(second.body.messages[1].content.map(block => block.name)).toEqual(upstreamNames);
    expect(second.body.messages[2].content.map(block => block.tool_use_id)).toEqual(calls.map(call => call.id));
    expect(second.body.tool_choice).toEqual({ type: "tool", name: upstreamName(toolNameMap, "read") });
  });

  it("leaves unmapped, decoy and non-tool events unchanged under an active map and without a map", async () => {
    const { toolNameMap } = derive();
    const events = [
      toolStart(1, "toolu_bash", "Bash"),
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "", name: upstreamName(toolNameMap, "read") } }
    ];
    expect(parseEvents(await runStream(events.map(frame).join(""), { toolNameMap }))).toEqual(events);

    const mappedLooking = [toolStart(0, "toolu_map", "write_ide"), toolStart(1, "toolu_plain", "read_ide")];
    expect(parseEvents(await runStream(mappedLooking.map(frame).join(""), { toolNameMap: null }))).toEqual(mappedLooking);
  });

  it.each([false, true])("keeps thinking, redacted, ping, caller, future fields and terminal events (fragmented=%s)", async fragmented => {
    const { toolNameMap } = derive();
    const wireEvents = richEvents(name => upstreamName(toolNameMap, name));
    const raw = await runStream(wireEvents.map(frame).join(""), { toolNameMap, fragmented });

    expect(parseEvents(raw)).toEqual(richEvents(name => name));
    for (const event of wireEvents.filter(event => !isToolStart(event))) expect(raw).toContain(frame(event));
  });

  it("passes an overloaded error event through without fabricating a terminal", async () => {
    const { toolNameMap } = derive();
    const events = [messageStart, { type: "error", error: { type: "overloaded_error", message: "Overloaded", retry_after: 3 }, request_id: "req_overloaded_1" }];
    const out = parseEvents(await runStream(events.map(frame).join(""), { toolNameMap }));
    expect(out).toEqual(events);
    expect(out.map(event => event.type)).toEqual(["message_start", "error"]);
  });

  it.each([
    ["mapped", "read_ide", "read"],
    ["unmapped", "Bash", "Bash"]
  ])("frames a final %s tool data line without trailing newline before [DONE]", async (_, upstream, expected) => {
    const { toolNameMap } = derive();
    const name = upstream === "read_ide" ? upstreamName(toolNameMap, "read") : upstream;
    const start = toolStart(0, "toolu_eof_1", name);
    const wire = frame(messageStart) + `event: content_block_start\ndata: ${JSON.stringify(start)}`;

    const raw = await runStream(wire, { toolNameMap });
    expect(parseEvents(raw)).toEqual([messageStart, toolStart(0, "toolu_eof_1", expected)]);
  });

  it("restores a single non-streaming tool name while keeping signed thinking and extra fields", async () => {
    const request = { tools: [{ name: "view_file", input_schema: { type: "object" } }], messages: [{ role: "user", content: "open" }] };
    const { toolNameMap } = cloakClaudeTools(request);
    const [providerName] = toolNameMap.keys();
    const providerBody = {
      id: "msg_nonstream_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "thinking", thinking: "Need file", signature: "sig_opaque" },
        { type: "tool_use", id: "toolu_view_1", name: providerName, input: { path: "a.txt" }, caller: { type: "direct" } }
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
      future_field: { kept: true }
    };

    const result = await handleNonStreamingResponse({
      providerResponse: new Response(JSON.stringify(providerBody), { status: 200, headers: { "content-type": "application/json" } }),
      provider: "claude",
      model: "claude-opus-5-5",
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.CLAUDE,
      body: request,
      stream: false,
      requestStartTime: Date.now(),
      toolNameMap,
      reqLogger: { logProviderResponse() { }, logConvertedResponse() { } },
      trackDone() { },
      appendLog() { }
    });

    const body = await result.response.json();
    expect({ ...body, usage: null }).toEqual({
      ...providerBody,
      content: [providerBody.content[0], { ...providerBody.content[1], name: "view_file" }],
      usage: null
    });
  });
});

