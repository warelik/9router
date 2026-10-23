// Zed completions wire acceptance: the `provider` field of POST /completions
// must use cloud.zed.dev's exact wire values (anthropic/open_ai/google/x_ai),
// and the Zed Gemini path must not carry the shared translator's
// safetySettings (Zed's hosted Gemini backend speaks the Vertex safety
// vocabulary, not the public-Gemini enums).
import { describe, it, expect, beforeEach, vi } from "vitest";

// Continuity regressions use the real RAM caches, without a live SQLite store.
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}),
  }),
}));

vi.mock("open-sse/shared/zedAuth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveZedModels: vi.fn(),
    zedLlmFetch: vi.fn(),
  };
});

import {
  resolveZedModels,
  zedLlmFetch,
} from "open-sse/shared/zedAuth.js";
import ZedExecutor from "open-sse/executors/zed.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function catalogFor(entries) {
  const rawById = new Map(entries);
  return { rawById, models: [] };
}

function mockCatalogFetch(captured) {
  zedLlmFetch.mockImplementation(async (credentials, path, options) => {
    captured.body = JSON.parse(options.fetchOptions.body);
    return new Response("upstream-error-stub", { status: 500 });
  });
}

function makeExecutor() {
  const executor = new ZedExecutor();
  executor.config = {};
  return executor;
}

const CHAT_BODY = { messages: [{ role: "user", content: "hi" }] };

const CONTINUITY_MODEL = "gemini-3.5-flash-lite";
function googleReply(parts, responseId) {
  return new Response(JSON.stringify({ event: {
    responseId, modelVersion: CONTINUITY_MODEL,
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  } }) + '\n' + JSON.stringify({ status: "stream_ended" }) + '\n', {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

async function readTurn(response) {
  const raw = await response.text();
  const chunks = raw.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
  const text = field => chunks.map(chunk => chunk.choices?.[0]?.delta?.[field] || "").join("");
  return { content: text("content"), reasoning_content: text("reasoning_content") };
}

const modelParts = request => request.provider_request.contents.filter(item => item.role === "model")
  .flatMap(item => item.parts);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("wire provider enum", () => {
  it.each([
    ["Anthropic", "anthropic"],
    ["anthropic", "anthropic"],
    ["OpenAi", "open_ai"],
    ["open_ai", "open_ai"],
    ["Google", "google"],
    ["gemini", "google"],
    ["XAi", "x_ai"],
    ["x_ai", "x_ai"],
  ])("catalog provider %j normalizes to wire %j", async (catalogValue, wire) => {
    resolveZedModels.mockResolvedValue(catalogFor([["m", { provider: catalogValue }]]));
    const executor = makeExecutor();
    const { provider } = await executor.resolveModel("m", {}, null, null);
    expect(provider).toBe(wire);
  });

  it("infers wire provider from the model id when the catalog is unavailable", async () => {
    resolveZedModels.mockRejectedValue(new Error("catalog down"));
    const executor = makeExecutor();
    const log = { warn: vi.fn() };
    expect((await executor.resolveModel("claude-opus-x", {}, null, log)).provider).toBe("anthropic");
    expect((await executor.resolveModel("gemini-3-x", {}, null, log)).provider).toBe("google");
    expect((await executor.resolveModel("grok-4-x", {}, null, log)).provider).toBe("x_ai");
    expect((await executor.resolveModel("gpt-5-x", {}, null, log)).provider).toBe("open_ai");
  });
});

describe("completion payload shaping", () => {
  it("sends wire provider values per model family", async () => {
    resolveZedModels.mockImplementation(async () => catalogFor([
      ["claude-x", { provider: "anthropic" }],
      ["gpt-x", { provider: "open_ai" }],
      ["gemini-x", { provider: "google" }],
      ["grok-x", { provider: "x_ai" }],
    ]));
    const captured = {};
    mockCatalogFetch(captured);
    const executor = makeExecutor();

    for (const [model, wire] of [
      ["claude-x", "anthropic"],
      ["gpt-x", "open_ai"],
      ["gemini-x", "google"],
      ["grok-x", "x_ai"],
    ]) {
      await executor.execute({ model, body: { ...CHAT_BODY }, stream: false, credentials: {} });
      expect(captured.body.provider).toBe(wire);
      expect(captured.body.model).toBe(model);
    }
  });

  it("strips safetySettings on the Zed Gemini path only", async () => {
    resolveZedModels.mockImplementation(async () => catalogFor([
      ["gemini-x", { provider: "google" }],
      ["claude-x", { provider: "anthropic" }],
    ]));
    const captured = {};
    mockCatalogFetch(captured);
    const executor = makeExecutor();

    await executor.execute({ model: "gemini-x", body: { ...CHAT_BODY }, stream: false, credentials: {} });
    expect(captured.body.provider).toBe("google");
    expect(captured.body.provider_request).not.toHaveProperty("safetySettings");

    // Sanity: the shared translator still emits safetySettings — the removal
    // happens in the Zed executor, not in shared/native Gemini behavior.
    const { openaiToGeminiRequest } = await import(
      "open-sse/translator/request/openai-to-gemini.js"
    );
    expect(openaiToGeminiRequest("gemini-x", { ...CHAT_BODY }, true)).toHaveProperty(
      "safetySettings",
    );
  });

  it("keeps all instruction text in systemInstruction and never leaks translator metadata into provider_request", async () => {
    resolveZedModels.mockImplementation(async () => catalogFor([
      ["gemini-x", { provider: "google" }],
    ]));
    const captured = {};
    mockCatalogFetch(captured);
    const executor = makeExecutor();

    await executor.execute({
      model: "gemini-x",
      body: {
        messages: [
          { role: "system", content: "SYS_ONE" },
          { role: "developer", content: "DEV_ONE" },
          { role: "user", content: "hi" },
        ],
        tools: [{
          type: "function",
          function: {
            name: "rich_tool",
            parameters: {
              type: "object",
              properties: { count: { type: "integer", minimum: 1, maximum: 5 } },
            },
          },
        }],
        _customToolNames: ["custom_one"],
        _toolNameMap: new Map([["cloaked", "orig"]]),
      },
      stream: false,
      credentials: {},
    });

    const req = captured.body.provider_request;
    const sysText = JSON.stringify(req.systemInstruction);
    expect(sysText).toContain("SYS_ONE");
    expect(sysText).toContain("DEV_ONE");
    expect(JSON.stringify(req)).not.toContain("_customToolNames");
    expect(JSON.stringify(req)).not.toContain("_toolNameMap");
    expect(req).not.toHaveProperty("_customToolNames");
    expect(req).not.toHaveProperty("_toolNameMap");
  });

  const ZED_TOOL_HISTORY = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "function_call", name: "alpha", call_id: "call.1", arguments: "{}" },
      { type: "function_call", name: "beta", call_id: "call1", arguments: "{}" },
      { type: "function_call", name: "ghost", call_id: "c-miss", arguments: "{}" },
      { type: "function_call_output", call_id: "call1", output: "B" },
      { type: "function_call_output", call_id: "call.1", output: "A" },
      { type: "function_call", name: "zeta", call_id: "c-tail", arguments: "{}" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "done" }] },
    ],
    reasoning: { effort: "high" },
    max_output_tokens: 128,
  };

  it("google backend keeps client ids, chronological results, high thinking and upstream answer headroom", async () => {
    resolveZedModels.mockImplementation(async () => catalogFor([
      ["gemini-3.5-flash-lite", { provider: "google" }],
    ]));
    const captured = {};
    mockCatalogFetch(captured);
    const executor = makeExecutor();

    const deferred = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gemini-3.5-flash-lite", structuredClone(ZED_TOOL_HISTORY), false, {}, "zed");
    const assistant = deferred.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(assistant.tool_calls.map((t) => t.id)).toEqual(["call.1", "call1", "c-miss"]);
    expect(deferred.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(deferred.reasoning_effort).toBe("high");

    await executor.execute({ model: "gemini-3.5-flash-lite", body: deferred, stream: false, credentials: {} });

    const req = captured.body.provider_request;
    const calls = req.contents.flatMap((c) => c.parts.filter((p) => p.functionCall).map((p) => p.functionCall));
    expect(calls.map((c) => c.id)).toEqual(["call.1", "call1", "c-miss", "c-tail"]);
    const resps = req.contents.flatMap((c) => c.parts.filter((p) => p.functionResponse).map((p) => p.functionResponse));
    expect(resps.map((r) => r.id)).toEqual(["call1", "call.1"]);
    expect(resps.map((r) => r.name)).toEqual(["beta", "alpha"]);
    expect(req.generationConfig.thinkingConfig).toMatchObject({ thinkingLevel: "high" });
    expect(req.generationConfig.maxOutputTokens).toBe(65535);
  });

  it("anthropic backend retains Anthropic id sanitation and placeholder results", async () => {
    resolveZedModels.mockImplementation(async () => catalogFor([
      ["claude-sonnet-4.5", { provider: "anthropic" }],
    ]));
    const captured = {};
    mockCatalogFetch(captured);
    const executor = makeExecutor();

    const deferred = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "claude-sonnet-4.5", structuredClone(ZED_TOOL_HISTORY), false, {}, "zed");

    await executor.execute({ model: "claude-sonnet-4.5", body: deferred, stream: false, credentials: {} });

    const req = captured.body.provider_request;
    const toolUses = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "tool_use"));
    for (const tu of toolUses) {
      expect(tu.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    const toolResults = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "tool_result"));
    expect(toolResults.length).toBeGreaterThanOrEqual(3);
    const uncoveredId = toolUses.at(-1).id;
    expect(toolResults.some((tr) => tr.tool_use_id === uncoveredId)).toBe(true);
  });
});

describe("Google response continuity through the actual Zed executor", () => {
  beforeEach(() => {
    resolveZedModels.mockReset();
    zedLlmFetch.mockReset();
    resolveZedModels.mockResolvedValue(catalogFor([[CONTINUITY_MODEL, { provider: "google" }]]));
  });

  it("replays the issued text-turn signature and opaque server parts in the same tenant", async () => {
    const serverPart = { toolCall: { id: "zed-server-search", toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["zed continuity"] } }, thoughtSignature: "zed-server-signature" };
    const signature = "zed-issued-text-signature";
    const requests = [];
    zedLlmFetch.mockImplementation(async (_credentials, _path, options) => {
      requests.push(JSON.parse(options.fetchOptions.body));
      return requests.length === 1
        ? googleReply([serverPart, { thought: true, text: "zed scoped reasoning" },
          { text: "zed scoped answer", thoughtSignature: signature }], "zed-continuity-response")
        : new Response("not used", { status: 500 });
    });
    const executor = makeExecutor();
    const credentials = { _clientSessionId: "zed-client-continuity", _geminiServerPartsSessionId: "zed-tenant-continuity" };
    const history = [{ role: "system", content: "zed continuity rules" }, { role: "user", content: "zed unique continuity question" }];
    const first = await executor.execute({ model: CONTINUITY_MODEL, body: { messages: history }, stream: true, credentials });
    const turn = await readTurn(first.response);
    expect(turn).toEqual({ content: "zed scoped answer", reasoning_content: "zed scoped reasoning" });
    const messages = [...history, { role: "assistant", ...turn }, { role: "user", content: "continue" }];
    await executor.execute({ model: CONTINUITY_MODEL, body: { messages }, stream: true, credentials });
    expect(modelParts(requests[1])).toContainEqual({ text: turn.content, thoughtSignature: signature });
    expect(modelParts(requests[1])).toContainEqual(serverPart);
    await executor.execute({ model: CONTINUITY_MODEL, body: { messages }, stream: true,
      credentials: { ...credentials, _geminiServerPartsSessionId: "zed-other-tenant" } });
    expect(modelParts(requests[2]).some(part => part.toolCall?.id === "zed-server-search")).toBe(false);
  });

  it("snapshots each request scope before out-of-order responses sharing credentials", async () => {
    const requests = [];
    const resolve = [];
    zedLlmFetch.mockImplementation((_credentials, _path, options) => {
      requests.push(JSON.parse(options.fetchOptions.body));
      return requests.length <= 2 ? new Promise(done => resolve.push(done))
        : Promise.resolve(new Response("not used", { status: 500 }));
    });
    const executor = makeExecutor();
    const credentials = { _clientSessionId: "zed-concurrent-client", _geminiServerPartsSessionId: "zed-concurrent-tenant" };
    const histories = ["A", "B"].map(label => [{ role: "user", content: `zed concurrent unique question ${label}` }]);
    const pendingA = executor.execute({ model: CONTINUITY_MODEL, body: { messages: histories[0] }, stream: true, credentials });
    await vi.waitFor(() => expect(resolve).toHaveLength(1));
    const pendingB = executor.execute({ model: CONTINUITY_MODEL, body: { messages: histories[1] }, stream: true, credentials });
    await vi.waitFor(() => expect(resolve).toHaveLength(2));
    resolve[1](googleReply([{ text: "zed shared concurrent answer", thoughtSignature: "zed-concurrent-signature-B" }], "zed-concurrent-B"));
    const turnB = await readTurn((await pendingB).response);
    resolve[0](googleReply([{ text: "zed shared concurrent answer", thoughtSignature: "zed-concurrent-signature-A" }], "zed-concurrent-A"));
    const turnA = await readTurn((await pendingA).response);
    for (const [index, turn] of [turnA, turnB].entries()) {
      await executor.execute({ model: CONTINUITY_MODEL, stream: true, credentials,
        body: { messages: [...histories[index], { role: "assistant", ...turn }, { role: "user", content: "continue" }] } });
      expect(modelParts(requests[index + 2])).toContainEqual({ text: turn.content,
        thoughtSignature: `zed-concurrent-signature-${index === 0 ? "A" : "B"}` });
    }
  });

  it("keeps signatures for a repeated tool-call ID separate by client session", async () => {
    const requests = [];
    zedLlmFetch.mockImplementation(async (credentials, _path, options) => {
      requests.push(JSON.parse(options.fetchOptions.body));
      return requests.length <= 2 ? googleReply([{
        functionCall: { id: "zed-same-client-call", name: "read", args: {} },
        thoughtSignature: `zed-tool-${credentials._clientSessionId}`,
      }], `zed-tool-response-${requests.length}`) : new Response("not used", { status: 500 });
    });
    const executor = makeExecutor();
    for (const session of ["A", "B"]) {
      const first = await executor.execute({ model: CONTINUITY_MODEL, stream: true,
        body: { messages: [{ role: "user", content: `zed tool question ${session}` }] },
        credentials: { _clientSessionId: session, _geminiServerPartsSessionId: `zed-tool-tenant-${session}` } });
      await first.response.text();
    }
    for (const [index, session] of ["A", "B"].entries()) {
      await executor.execute({ model: CONTINUITY_MODEL, stream: true,
        credentials: { _clientSessionId: session, _geminiServerPartsSessionId: `zed-tool-tenant-${session}` },
        body: { messages: [{ role: "user", content: `zed tool question ${session}` },
          { role: "assistant", content: null, tool_calls: [{ id: "zed-same-client-call", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "zed-same-client-call", content: "done" },
          { role: "user", content: "continue" }] } });
      const part = modelParts(requests[index + 2]).find(item => item.functionCall?.id === "zed-same-client-call");
      expect(part.thoughtSignature).toBe(`zed-tool-${session}`);
    }
  });
});
