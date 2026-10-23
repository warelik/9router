// Real chat core + DefaultExecutor HTTP preparation. Only network/accounting
// boundaries are replaced. No provider requests, secrets, or live DB writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { network, executors } = vi.hoisted(() => ({ network: vi.fn(), executors: new Map() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: network }));
vi.mock("../../open-sse/executors/index.js", async () => {
  const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
  return { getExecutor(provider) {
    if (!executors.has(provider)) executors.set(provider, new DefaultExecutor(provider));
    return executors.get(provider);
  } };
});
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => new Proxy({}, { get: (_target, name) => name === "then" ? undefined : vi.fn() }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const model = "gemini-3.5-flash-lite";
const nativeReply = {
  candidates: [{ index: 0, content: { role: "model", parts: [
    { text: "THOUGHT", thought: true, thoughtSignature: "opaque-original-thought" },
    { functionCall: { id: "original-output-id", name: "init_worker", args: { task: "ARBITRARY_INIT_TASK" } }, thoughtSignature: "opaque-original-call" },
  ] }, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["q"] } }],
  usageMetadata: { promptTokenCount: 4096, cachedContentTokenCount: 2048, candidatesTokenCount: 17, thoughtsTokenCount: 20, totalTokenCount: 4133 },
  modelVersion: model, responseId: "native-reply-id",
};
function body(generation = { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } }) {
  return {
    systemInstruction: { parts: [{ text: "System A" }, { text: "System B" }] },
    contents: [
      { role: "user", parts: [{ text: "Run task" }] },
      { role: "model", parts: [{ functionCall: { id: "original-input-id", name: "read_seed", args: { init: { type: "customer", task: "INITIALIZATION_TASK" } } }, thoughtSignature: "opaque-input-signature" }] },
      { role: "user", parts: [{ functionResponse: { id: "original-input-id", name: "read_seed", response: { result: "DEPENDENT_RESULT", nested: { type: "customer" } } } }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] },
    ],
    tools: [{ functionDeclarations: [{ name: "read_seed", parametersJsonSchema: { type: "object", properties: { type: { type: "string" } }, additionalProperties: false } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_seed"] } },
    generationConfig: generation, cachedContent: "cachedContents/native-test",
    futureOpaqueExtension: { init_task: "FUTURE_INIT_TASK", nested: { type: "customer" } },
  };
}
const quiet = Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine"].map(name => [name, vi.fn()]));
async function run(provider, requestBody = body(), { suffix = "", stream = false, mode = "high", signal, ua = "Some arbitrary Gemini client", queryParams = [], clientHeaders = {}, onRequestSuccess, apiVersion = "v1beta", rawRequest, credentials: suppliedCredentials } = {}) {
  return handleChatCore({
    body: { ...structuredClone(requestBody), model: `${provider}/${model}${suffix}`, stream },
    modelInfo: { provider, model: model + suffix }, sourceFormatOverride: FORMATS.GEMINI,
    userAgent: ua, log: quiet, clientSignal: signal,
    onRequestSuccess,
    credentials: suppliedCredentials || { apiKey: "offline-provider-key", connectionId: "offline-native-test", providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid:18080", strictProxy: true } },
    connectionId: "offline-native-test", providerThinking: { mode },
    rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    clientRawRequest: rawRequest || { endpoint: `/${apiVersion}/models/${provider}/${model}${suffix}:${stream ? "streamGenerateContent" : "generateContent"}`, apiVersion, body: structuredClone(requestBody), queryParams, headers: { "user-agent": ua, ...clientHeaders } },
  });
}
const wireBody = () => JSON.parse(network.mock.calls.at(-1)[1].body);

describe("native Gemini requests through real chat core and executor", () => {
  beforeEach(() => {
    network.mockReset();
    executors.clear();
    network.mockImplementation(async () => Response.json(structuredClone(nativeReply)));
    vi.stubGlobal("fetch", vi.fn(() => { throw Error("DIRECT_NETWORK_FORBIDDEN"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const provider of ["gemini", "aistudio"]) {
    it(`${provider}: does not reuse a stale server-parts tenant scope in native passthrough`, async () => {
      const credentials = {
        apiKey: "offline-provider-key",
        connectionId: "offline-native-test",
        providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid:18080", strictProxy: true },
        _geminiServerPartsSessionId: JSON.stringify(["previous-tenant", "previous-conversation"]),
      };
      const result = await run(provider, body(), { credentials });
      expect(result.success).toBe(true);
      expect(credentials._geminiServerPartsSessionId).toBeNull();
      await result.response.text();
    });

    it(`${provider}: arbitrary client retains all history/tools/settings and strict proxy on the provider wire`, async () => {
      const original = body();
      const result = await run(provider, original);
      expect(result.success).toBe(true);
      expect(network).toHaveBeenCalledOnce();
      expect(wireBody()).toEqual(original);
      expect(wireBody()).not.toHaveProperty("model");
      expect(wireBody()).not.toHaveProperty("stream");
      expect(network.mock.calls[0][2]).toMatchObject({ strictProxy: true, connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.invalid:18080" });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(await result.response.json()).toEqual(nativeReply);
    });

    it.each(["v1", "v1beta"])(`${provider}: resolves provider wire independently from client %s without changing raw client metadata`, async apiVersion => {
      const original = body();
      const rawRequest = { endpoint: `/${apiVersion}/models/${provider}/${model}:generateContent`, apiVersion, body: structuredClone(original), queryParams: [], headers: {} };
      const before = structuredClone(rawRequest);
      const result = await run(provider, original, { rawRequest });
      expect(result.success).toBe(true);
      const wireVersion = provider === "aistudio" ? "v1beta" : apiVersion;
      expect(new URL(network.mock.calls[0][0]).pathname).toBe(`/${wireVersion}/models/${model}:generateContent`);
      expect(wireBody()).toEqual(original);
      expect(rawRequest).toEqual(before);
      expect(network).toHaveBeenCalledOnce();
      await result.response.text();
    });

    it.each([
      ["camel HIGH", { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: false } }],
      ["camel LOW", { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } }],
      ["budget zero", { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0, includeThoughts: false } }],
      ["SDK snake HIGH", { maxOutputTokens: 2048, thinkingConfig: { thinking_level: "HIGH", include_thoughts: false } }],
      ["SDK snake LOW", { maxOutputTokens: 2048, thinkingConfig: { thinking_level: "LOW", include_thoughts: false } }],
    ])(`${provider}: preserves explicit %s rather than replacing it with provider high`, async (_name, generation) => {
      const original = body(generation);
      const result = await run(provider, original);
      expect(result.success).toBe(true);
      expect(wireBody()).toEqual(original);
      await result.response.text();
    });

    it(`${provider}: adds a missing high default without changing client limits or include_thoughts=false`, async () => {
      const generation = { maxOutputTokens: 2048, temperature: 0, thinkingConfig: { include_thoughts: false } };
      const original = body(generation);
      const result = await run(provider, original);
      expect(wireBody()).toEqual({ ...original, generationConfig: { ...generation, thinkingConfig: { include_thoughts: false, thinkingLevel: "HIGH" } } });
      await result.response.text();
    });

    it(`${provider}: suffix overrides effort explicitly without raising the output limit or leaking into the Google URI`, async () => {
      const result = await run(provider, body(), { suffix: "(high)" });
      const thinking = wireBody().generationConfig.thinkingConfig;
      expect(thinking).toEqual({ thinkingLevel: "HIGH", includeThoughts: false });
      expect(wireBody().generationConfig.maxOutputTokens).toBe(2048);
      expect(network.mock.calls[0][0]).not.toContain("(high)");
      expect(new URL(network.mock.calls[0][0]).pathname).toContain(`${model}:generateContent`);
      await result.response.text();
    });

    it(`${provider}: fully snake-case native thinking keeps zero budget and disabled thought display`, async () => {
      const original = body();
      delete original.generationConfig;
      original.generation_config = { max_output_tokens: 2048, thinking_config: { thinking_budget: 0, include_thoughts: false } };
      const result = await run(provider, original);
      expect(wireBody()).toEqual(original);
      await result.response.text();
    });

    it(`${provider}: preserves client query parameters and ordinary headers while replacing client credentials`, async () => {
      const result = await run(provider, body(), {
        stream: true,
        queryParams: [["key", "client-router-key"], ["alt", "json"], ["future_param", "one"], ["future_param", "two"], ["prettyPrint", "false"]],
        clientHeaders: { Authorization: "Bearer client-router-key", "x-goog-api-key": "client-router-key", "x-goog-user-project": "fixture-project", "x-future-native": "fixture-value", cookie: "client-session=fixture" },
      });
      const url = new URL(network.mock.calls[0][0]);
      expect(url.searchParams.has("key")).toBe(false);
      expect(url.searchParams.get("alt")).toBe("json");
      expect(url.searchParams.getAll("future_param")).toEqual(["one", "two"]);
      expect(url.searchParams.get("prettyPrint")).toBe("false");
      const headers = new Headers(network.mock.calls[0][1].headers);
      expect(headers.get("x-goog-api-key")).toBe("offline-provider-key");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-goog-user-project")).toBe("fixture-project");
      expect(headers.get("x-future-native")).toBe("fixture-value");
      await result.response.text();
    });

    it(`${provider}: native stream action with JSON framing preserves upstream content type and raw array bytes`, async () => {
      const raw = `[ ${JSON.stringify(nativeReply)} ]`;
      network.mockImplementationOnce(async () => new Response(raw, { headers: { "Content-Type": "application/json; charset=utf-8" } }));
      const result = await run(provider, body(), { stream: true, queryParams: [["alt", "json"]] });
      expect(result.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await result.response.text()).toBe(raw);
    });

    it.each([
      ["fields query", [["fields", "candidates/content/parts/text"]], {}],
      ["$fields query", [["$fields", "candidates(content(parts(text)))"]], {}],
      ["fieldmask header", [], { "X-Goog-FieldMask": "candidates.content.parts.text" }],
    ])(`${provider}: %s projection remains transparent through the real core and stream observer`, async (_name, queryParams, clientHeaders) => {
      const projected = { candidates: [{ content: { parts: [{ text: "completed projected output" }] } }] };
      for (const nativeJson of [false, true]) {
        const raw = nativeJson ? JSON.stringify([projected]) : `data: ${JSON.stringify(projected)}\n\n`;
        network.mockImplementationOnce(async () => new Response(raw, { headers: { "Content-Type": nativeJson ? "application/json" : "text/event-stream" } }));
        const original = body();
        const result = await run(provider, original, { stream: true, queryParams, clientHeaders });
        expect(result.success).toBe(true);
        expect(await result.response.text()).toBe(raw);
        expect(wireBody()).toEqual(original);
        const url = new URL(network.mock.calls.at(-1)[0]);
        for (const [name, value] of queryParams) expect(url.searchParams.get(name)).toBe(value);
        const headers = new Headers(network.mock.calls.at(-1)[1].headers);
        for (const [name, value] of Object.entries(clientHeaders)) expect(headers.get(name)).toBe(value);
      }
    });

    it(`${provider}: stream=false selects generateContent and returns native JSON with no Chat bookkeeping`, async () => {
      const result = await run(provider);
      expect(new URL(network.mock.calls[0][0]).pathname.endsWith(":generateContent")).toBe(true);
      expect(network.mock.calls[0][1].headers.Accept).toBeUndefined();
      const response = await result.response.json();
      expect(response).toEqual(nativeReply);
      expect(response).not.toHaveProperty("object");
      expect(response).not.toHaveProperty("created");
      expect(response.usageMetadata.cachedContentTokenCount).toBe(2048);
    });

    it(`${provider}: a native error inside HTTP 200 is an error before success callbacks and retains details`, async () => {
      const error = { error: { code: 400, status: "INVALID_ARGUMENT", message: "fixture bad config", details: [{ field: "maxOutputTokens" }] }, futureDiagnostic: { type: "customer" } };
      const succeeded = vi.fn();
      network.mockImplementationOnce(async () => Response.json(error, { headers: { "Retry-After": "17", "Content-Encoding": "gzip", "Content-Length": "700" } }));
      const result = await run(provider, body(), { onRequestSuccess: succeeded });
      expect(result.success).toBe(false);
      expect(result.status).toBe(400);
      expect(result.nativeResponse).toBe(true);
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("retry-after")).toBe("17");
      expect(result.response.headers.get("content-encoding")).toBeNull();
      expect(result.response.headers.get("content-length")).toBeNull();
      expect(await result.response.json()).toEqual(error);
      expect(succeeded).not.toHaveBeenCalled();
      expect(network).toHaveBeenCalledOnce();
    });

    it(`${provider}: unexpected SSE on native generateContent fails without a Chat pivot or success callback`, async () => {
      const succeeded = vi.fn();
      const cancelled = vi.fn();
      const upstream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(nativeReply)}\n\n`)); },
        cancel: cancelled,
      });
      network.mockImplementationOnce(async () => new Response(upstream, { headers: { "Content-Type": "text/event-stream" } }));
      const result = await run(provider, body(), { onRequestSuccess: succeeded });
      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(await result.response.json()).toMatchObject({ error: { code: 502, message: expect.stringContaining("Unexpected streaming response") } });
      expect(succeeded).not.toHaveBeenCalled();
      expect(cancelled).toHaveBeenCalledOnce();
      expect(network).toHaveBeenCalledOnce();
    });

    it(`${provider}: HTML inside streaming HTTP 200 returns native 502 rather than an empty SDK success`, async () => {
      const succeeded = vi.fn();
      network.mockImplementationOnce(async () => new Response("<html><title>Upstream unavailable</title></html>", { headers: { "Content-Type": "text/html", "Retry-After": "17" } }));
      const result = await run(provider, body(), { stream: true, onRequestSuccess: succeeded });
      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(result.response.status).toBe(502);
      expect(result.response.headers.get("retry-after")).toBe("17");
      expect(await result.response.json()).toMatchObject({ error: { code: 502, status: "INTERNAL", message: expect.stringContaining("Upstream unavailable") } });
      expect(succeeded).not.toHaveBeenCalled();
      expect(network).toHaveBeenCalledOnce();
    });

    it(`${provider}: HTTP 200 quota errors remain retriable native 429 errors`, async () => {
      const error = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ retryDelay: "17s" }] } };
      network.mockImplementationOnce(async () => Response.json(error));
      const result = await run(provider);
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(429);
      expect(await result.response.json()).toEqual(error);
    });

    it(`${provider}: native errors retain their status when malformed candidate fields are also present`, async () => {
      const error = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" }, candidates: {} };
      const succeeded = vi.fn();
      network.mockImplementationOnce(async () => Response.json(error));
      const result = await run(provider, body(), { onRequestSuccess: succeeded });
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(429);
      expect(await result.response.json()).toEqual(error);
      expect(succeeded).not.toHaveBeenCalled();
    });

    it.each([
      ["null", null],
      ["empty array", []],
      ["response array", [nativeReply]],
      ["string", "unexpected response"],
      ["scalar", 17],
      ["empty object", {}],
      ["unknown object", { message: "bridge failure" }],
      ["event-only object", { event: "bridge_failure", data: "unavailable" }],
      ["wrapped unknown object", { response: { message: "bridge failure" } }],
      ["null response wrapper", { response: null }],
      ["false response wrapper", { response: false }],
      ["zero response wrapper", { response: 0 }],
      ["empty-string response wrapper", { response: "" }],
      ["unprojected unknown-only extension", { futureNativeResult: { task: { type: "customer", value: 9 } } }],
      ["non-array candidates", { candidates: {} }],
      ["null candidate entry", { candidates: [null] }],
    ])(`${provider}: rejects invalid native JSON response shape %s rather than a successful empty SDK result`, async (_shape, response) => {
      const succeeded = vi.fn();
      network.mockImplementationOnce(async () => Response.json(response));
      const result = await run(provider, body(), { onRequestSuccess: succeeded });
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(502);
      expect(await result.response.json()).toMatchObject({ error: { code: 502, status: "INTERNAL", message: expect.stringContaining("Invalid native Gemini response") } });
      expect(succeeded).not.toHaveBeenCalled();
    });

    it.each([
      [[["fields", "modelStatus"]], {}],
      [[["$fields", "modelStatus"]], {}],
      [[], { "x-goog-fieldmask": "modelStatus" }],
    ])(`${provider}: preserves a deliberately projected empty native JSON object`, async (queryParams, clientHeaders) => {
      network.mockImplementationOnce(async () => Response.json({}));
      const result = await run(provider, body(), { queryParams, clientHeaders });
      expect(result.success).toBe(true);
      expect(result.response.status).toBe(200);
      expect(await result.response.json()).toEqual({});
    });

    it(`${provider}: preserves a projected null wrapper without inventing a failure`, async () => {
      const response = { response: null };
      const succeeded = vi.fn();
      network.mockImplementationOnce(async () => Response.json(response));
      const result = await run(provider, body(), {
        queryParams: [["fields", "modelStatus"]], onRequestSuccess: succeeded,
      });
      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual(response);
      await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
    });

    it.each([
      { promptFeedback: { blockReason: "SAFETY" } },
      { candidates: [{ index: 0, finishReason: "MAX_TOKENS", content: { role: "model", parts: [] } }] },
      { usageMetadata: { totalTokenCount: 0 } },
      { modelVersion: "gemini-native-test" },
      { responseId: "native-metadata-only" },
      { response: null, responseId: "native-outer-fallback" },
      { modelStatus: { message: "native model status" } },
      { createTime: "2026-10-23T00:00:00Z" },
      { responseId: "native-with-extension", futureNativeResult: { task: { type: "customer", value: 9 } } },
      { futureNativeResult: { task: { type: "customer", value: 9 } } },
    ])(`${provider}: preserves native blocked, finished zero-content and nonempty future responses`, async response => {
      const succeeded = vi.fn();
      network.mockImplementationOnce(async () => Response.json(response));
      // A future-only reply is legitimate when the client explicitly projects
      // out the existing response fields. Preserve the original body/assertions.
      const queryParams = response.futureNativeResult && !response.responseId
        ? [["fields", "futureNativeResult"]] : [];
      const result = await run(provider, body(), { onRequestSuccess: succeeded, queryParams });
      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual(response);
      await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
    });

    it(`${provider}: unknown native root fields never enter Chat finish, reasoning or usage mutators`, async () => {
      const response = { ...structuredClone(nativeReply),
        choices: [{ finish_reason: "NATIVE_OPAQUE_FINISH", message: { content: "future native field", reasoning_content: "preserve this opaque value", tool_calls: [{ id: "opaque-future-call" }] } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, futureMetric: { type: "customer" } },
      };
      network.mockImplementationOnce(async () => Response.json(response));
      const result = await run(provider);
      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual(response);
    });

    it(`${provider}: repeated native history preserves the exact provider request prefix`, async () => {
      const original = body();
      const first = await run(provider, original);
      await first.response.text();
      const second = await run(provider, original);
      await second.response.text();
      expect(network).toHaveBeenCalledTimes(2);
      expect(network.mock.calls[1][1].body).toBe(network.mock.calls[0][1].body);
      expect(wireBody().cachedContent).toBe(original.cachedContent);
    });

    it(`${provider}: streaming forwards calls/signatures and finish-before-usage to an arbitrary native SDK`, async () => {
      const chunks = [{ ...nativeReply, usageMetadata: undefined }, { usageMetadata: nativeReply.usageMetadata }];
      const sse = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
      network.mockImplementationOnce(async () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }));
      const result = await run(provider, body(), { stream: true });
      expect(new URL(network.mock.calls[0][0]).pathname.endsWith(":streamGenerateContent")).toBe(true);
      expect(await result.response.text()).toBe(sse);
    });

    it(`${provider}: native 429 preserves original error bytes, RetryInfo and Retry-After`, async () => {
      const raw = '{ "error": { "code": 429, "status": "RESOURCE_EXHAUSTED", "message": "fixture quota", "details": [{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"17s"}] } }';
      // Node fetch has already decoded gzip but keeps these upstream headers.
      network.mockImplementationOnce(async () => new Response(raw, { status: 429, headers: {
        "Content-Type": "application/json", "Retry-After": "17", "Content-Encoding": "gzip",
        "Content-Length": "109", "Transfer-Encoding": "chunked",
      } }));
      const result = await run(provider);
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get("retry-after")).toBe("17");
      expect(result.response.headers.get("content-encoding")).toBeNull();
      expect(result.response.headers.get("content-length")).toBeNull();
      expect(result.response.headers.get("transfer-encoding")).toBeNull();
      expect(await result.response.text()).toBe(raw);
      expect(network).toHaveBeenCalledOnce();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it(`${provider}: pre-aborted client does not start a provider request`, async () => {
      const client = new AbortController();
      client.abort();
      const result = await run(provider, body(), { signal: client.signal });
      expect(result.response.status).toBe(499);
      expect(network).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it(`${provider}: abort during fetch cancels the real executor signal without retry or direct fallback`, async () => {
      const client = new AbortController();
      network.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("fixture abort", "AbortError")), { once: true });
        client.abort();
      }));
      const result = await run(provider, body(), { signal: client.signal });
      expect(result.response.status).toBe(499);
      expect(network.mock.calls[0][1].signal.aborted).toBe(true);
      expect(network).toHaveBeenCalledOnce();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  }

  it("an OpenAI Chat client still translates to Gemini and receives a Chat completion", async () => {
    network.mockImplementationOnce(async () => Response.json({ candidates: [{ content: { parts: [{ text: "translated reply" }] }, finishReason: "STOP" }], modelVersion: model }));
    const result = await handleChatCore({
      body: { model: `gemini/${model}`, stream: false, messages: [{ role: "user", content: "chat prompt" }] },
      modelInfo: { provider: "gemini", model }, sourceFormatOverride: FORMATS.OPENAI,
      credentials: { apiKey: "offline-key", providerSpecificData: {} }, log: quiet,
      rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, pxpipeEnabled: false,
    });
    expect(wireBody().contents[0].parts[0].text).toBe("chat prompt");
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("translated reply");
  });
});

describe("AIStudio stable client provider routing regression", () => {
  it("avoids the saved browser-auth v1 404 through the real core while the generic formatter still honors v1", async () => {
    network.mockReset();
    executors.clear();
    const original = body();
    const rawRequest = { endpoint: `/v1/models/aistudio/${model}:generateContent`, apiVersion: "v1", body: structuredClone(original), queryParams: [["fields", "candidates"]], headers: {} };
    const before = structuredClone(rawRequest);
    const savedBrowserError = { error: { code: 404, status: "INTERNAL", message: 'Proxy browser error: Google API returned error: 404 NOT_FOUND {"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}' } };
    network.mockImplementation(async url => new URL(url).pathname.startsWith("/v1/models/")
      ? Response.json(savedBrowserError, { status: 404 }) : Response.json(nativeReply));
    const result = await run("aistudio", original, { rawRequest });
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual(nativeReply);
    expect(new URL(network.mock.calls[0][0]).pathname).toBe(`/v1beta/models/${model}:generateContent`);
    expect(new URL(network.mock.calls[0][0]).searchParams.get("fields")).toBe("candidates");
    expect(wireBody()).toEqual(original);
    expect(rawRequest).toEqual(before);
    expect(network).toHaveBeenCalledOnce();
    const generic = executors.get("aistudio").buildUrl(model, false, 0, { nativeGeminiPassthrough: true, nativeGeminiRequest: { apiVersion: "v1" } });
    expect(new URL(generic).pathname).toBe(`/v1/models/${model}:generateContent`);
  });
});
