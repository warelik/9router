// Portable Responses input for strict upstreams (quirks.portableResponsesInput).
// Unit cases exercise toPortableResponsesInput directly; the integration case drives
// the REAL handleChatCore with the kimi responses transport and asserts the body
// that reaches the executor.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { toPortableResponsesInput } = await import("../../open-sse/translator/formats/responsesApi.js");
const { resolveTransport } = await import("../../open-sse/services/provider.js");

const FERNET = "gAAAAABhY2NlcnNlcy1lbmNyeXB0ZWQ";
const KIMI_REASONING = "WGQqTm90RmVybmV0";

const RESPONSE_JSON = {
  id: "resp_1", object: "response", created_at: 0, status: "completed", model: "test",
  output: [{
    type: "message", id: "msg_1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  }],
};

function okResponse() {
  return new Response(JSON.stringify(RESPONSE_JSON), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

describe("toPortableResponsesInput", () => {
  it("rewrites agent_message to a user message with only its input_text parts", () => {
    const agent = {
      type: "agent_message", author: "a", recipient: "b",
      content: [
        { type: "input_text", text: "delegated ask" },
        { type: "encrypted_content", encrypted_content: FERNET },
      ],
    };
    const out = toPortableResponsesInput([agent]);
    expect(out).toEqual([{
      type: "message", role: "user",
      content: [{ type: "input_text", text: "delegated ask" }],
    }]);
  });

  it("drops agent_message without input_text parts", () => {
    const out = toPortableResponsesInput([{
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: FERNET }],
    }]);
    expect(out).toEqual([]);
  });

  it("rewrites call_id-less function_call_output with a string output", () => {
    const out = toPortableResponsesInput([{
      type: "function_call_output", name: "send_message_to_thread",
      namespace: "codex_tui", output: "<codex_delegation>result</codex_delegation>",
    }]);
    expect(out).toEqual([{
      type: "message", role: "user",
      content: [{ type: "input_text", text: "<codex_delegation>result</codex_delegation>" }],
    }]);
  });

  it("rewrites call_id-less custom_tool_call_output with array output to text/image parts", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,x" };
    const out = toPortableResponsesInput([{
      type: "custom_tool_call_output", output: [
        { type: "input_text", text: "part" },
        image,
        { type: "encrypted_content", encrypted_content: FERNET },
      ],
    }]);
    expect(out).toEqual([{
      type: "message", role: "user",
      content: [{ type: "input_text", text: "part" }, image],
    }]);
  });

  it("drops call_id-less tool outputs with empty output", () => {
    const out = toPortableResponsesInput([
      { type: "function_call_output", output: "" },
      { type: "function_call_output", output: [] },
      { type: "function_call_output" },
    ]);
    expect(out).toEqual([]);
  });

  it("drops Fernet-only reasoning with no readable summary or content", () => {
    const out = toPortableResponsesInput([
      { type: "reasoning", id: "rs_1", encrypted_content: FERNET, summary: [] },
      { type: "reasoning", id: "rs_2", encrypted_content: `${FERNET}==`, summary: [{ type: "summary_text", text: "   " }] },
    ]);
    expect(out).toEqual([]);
  });

  it("preserves Fernet reasoning that carries readable summary text", () => {
    const item = {
      type: "reasoning", id: "rs_1", encrypted_content: FERNET,
      summary: [{ type: "summary_text", text: "thought about it" }],
    };
    const out = toPortableResponsesInput([item]);
    expect(out[0]).toBe(item);
  });

  it("preserves non-Fernet provider-native reasoning", () => {
    const item = { type: "reasoning", id: "rs_QssX1", encrypted_content: KIMI_REASONING };
    const out = toPortableResponsesInput([item]);
    expect(out[0]).toBe(item);
  });

  it("leaves other items untouched and does not mutate the caller's array", () => {
    const ws = { type: "web_search_call", id: "ws_1", status: "completed" };
    const custom = { type: "custom_tool_call", call_id: "c1", name: "x", input: "{}" };
    const paired = { type: "function_call_output", call_id: "c1", output: "done" };
    const msg = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] };
    const input = [ws, custom, paired, msg];
    const out = toPortableResponsesInput(input);
    expect(out).toEqual(input);
    expect(out[0]).toBe(ws);
    expect(input).toHaveLength(4);
  });
});

describe("handleChatCore applies portable Responses input per transport quirk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async () => ({
      response: okResponse(), url: "https://api.kimi.com/coding/v1/responses", headers: {},
    }));
  });

  it("declares the quirk on the kimi openai-responses transport only", () => {
    expect(resolveTransport("kimi", "openai-responses")?.quirks?.portableResponsesInput).toBe(true);
    expect(resolveTransport("kimi", "openai")?.quirks?.portableResponsesInput).toBeUndefined();
    expect(resolveTransport("kimi", "claude")?.quirks?.portableResponsesInput).toBeUndefined();
  });

  it("rewrites a Codex multi-agent history for the kimi Responses endpoint", async () => {
    const result = await handleChatCore({
      body: {
        model: "kimi/kimi-k3", stream: false,
        input: [
          { type: "reasoning", id: "rs_1", encrypted_content: FERNET, summary: [] },
          { type: "reasoning", id: "rs_kimi", encrypted_content: KIMI_REASONING },
          { type: "web_search_call", id: "ws_1", status: "completed" },
          { type: "function_call", call_id: "call_1", name: "run", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "tool out" },
          { type: "function_call_output", name: "send_message_to_thread", namespace: "codex_tui", output: "delegated" },
          {
            type: "agent_message", author: "a", recipient: "b",
            content: [{ type: "input_text", text: "agent text" }, { type: "encrypted_content", encrypted_content: FERNET }],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      },
      modelInfo: { provider: "kimi", model: "kimi-k3" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      connectionId: "kimi-portable-test",
      sourceFormatOverride: "openai-responses",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    expect(result.success).toBe(true);
    const { credentials: creds, body: sent } = executeMock.mock.calls.at(-1)[0];
    expect(creds.runtimeTransport?.format).toBe("openai-responses");
    expect(Array.isArray(sent.input)).toBe(true);
    expect(sent.input.some(i => i.type === "agent_message")).toBe(false);
    expect(sent.input.some(i => i.type === "reasoning" && String(i.encrypted_content || "").startsWith("gAAAAA"))).toBe(false);
    expect(sent.input).toContainEqual({ type: "reasoning", id: "rs_kimi", encrypted_content: KIMI_REASONING });
    expect(sent.input.some(i => i.type === "web_search_call")).toBe(true);
    expect(sent.input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "tool out" });
    expect(sent.input).toContainEqual({
      type: "message", role: "user", content: [{ type: "input_text", text: "agent text" }],
    });
    expect(sent.input).toContainEqual({
      type: "message", role: "user", content: [{ type: "input_text", text: "delegated" }],
    });
  });

  it("does not transform a codex provider request", async () => {
    const input = [
      { type: "agent_message", content: [{ type: "input_text", text: "agent text" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: FERNET, summary: [] },
      { type: "function_call_output", name: "send_message_to_thread", output: "delegated" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ];
    const result = await handleChatCore({
      body: { model: "cx/gpt-5.5", stream: false, input: structuredClone(input) },
      modelInfo: { provider: "codex", model: "gpt-5.5" },
      credentials: { accessToken: "tok", providerSpecificData: {} },
      connectionId: "cx-portable-test",
      sourceFormatOverride: "openai-responses",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    expect(result.success).toBe(true);
    const { body: sent } = executeMock.mock.calls.at(-1)[0];
    expect(sent.input).toEqual(input);
  });

  it.each([
    ["gemini", false], ["gemini", true],
    ["aistudio", false], ["aistudio", true],
    ["antigravity", false], ["antigravity", true],
    ["kimi", false], ["kimi", true],
  ])("rejects opaque task before %s execution (stream=%s)", async (provider, stream) => {
    const input = [{ type: "agent_message", author: "/root", recipient: "/root/probe", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:" },
      { type: "encrypted_content", encrypted_content: FERNET },
    ] }];
    const model = provider === "kimi" ? "kimi-k3" : "gemini-3.8-flash";
    const before = structuredClone(input);
    const result = await handleChatCore({
      body: { model, stream, input },
      modelInfo: { provider, model },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      connectionId: "opaque-cross-format-test",
      sourceFormatOverride: "openai-responses",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(400);
    expect((await result.response.json()).error.message).toContain("encrypted Codex agent_message");
    expect(executeMock).not.toHaveBeenCalled();
    expect(input).toEqual(before);
  });

  it.each(["message", "agent_message"])("does not discard an unreadable task before a readable %s follow-up", async type => {
    const opaque = { type: "agent_message", author: "/root", recipient: "/root/probe", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:" },
      { type: "encrypted_content", encrypted_content: FERNET },
    ] };
    const followup = type === "message"
      ? { type, role: "user", content: [{ type: "input_text", text: "Continue under the original task constraints." }] }
      : { type, author: "/root", recipient: "/root/probe", content: [
          { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root/probe\nSender: /root\nPayload:" },
          { type: "encrypted_content", encrypted_content: "Continue under the original task constraints." },
        ] };
    const input = [opaque, followup];
    const before = structuredClone(input);
    const result = await handleChatCore({
      body: { model: "kimi-k3", stream: false, input },
      modelInfo: { provider: "kimi", model: "kimi-k3" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      connectionId: "opaque-history-test", sourceFormatOverride: "openai-responses",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
    expect(input).toEqual(before);
  });

  it("keeps a native Codex metadata-only carrier unchanged", async () => {
    const input = [{ type: "agent_message", author: "/root", recipient: "/root/probe", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\n\nPayload:" },
      { type: "encrypted_content", encrypted_content: FERNET },
    ] }];
    const result = await handleChatCore({
      body: { model: "cx/gpt-5.5", stream: false, input: structuredClone(input) },
      modelInfo: { provider: "codex", model: "gpt-5.5" },
      credentials: { accessToken: "tok", providerSpecificData: {} },
      connectionId: "cx-opaque-native-test",
      sourceFormatOverride: "openai-responses",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });
    expect(result.success).toBe(true);
    const { body: sent } = executeMock.mock.calls.at(-1)[0];
    expect(sent.input).toEqual(input);
  });
});
