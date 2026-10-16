// Zed completions wire acceptance: the `provider` field of POST /completions
// must use cloud.zed.dev's exact wire values (anthropic/open_ai/google/x_ai),
// and the Zed Gemini path must not carry the shared translator's
// safetySettings (Zed's hosted Gemini backend speaks the Vertex safety
// vocabulary, not the public-Gemini enums).
import { describe, it, expect, beforeEach, vi } from "vitest";

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
