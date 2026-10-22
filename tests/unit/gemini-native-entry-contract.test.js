import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Real endpoint + handler control flow. Only imported service boundaries are
// replaced; no database, external fetch, model, or provider account is contacted.
const root = fileURLToPath(new URL("../../", import.meta.url));
function moduleSource(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8")
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/^export /gm, "");
}
function nativeBody() {
  return {
    systemInstruction: { parts: [{ text: "Initialization instruction" }] },
    contents: [
      { role: "user", parts: [{ text: "Use the tool result" }] },
      { role: "model", parts: [{ functionCall: { id: "call-1", name: "task", args: { type: "customer", task: "init" } }, thoughtSignature: "fixture-provider-signature" }] },
      { role: "user", parts: [{ functionResponse: { id: "call-1", name: "task", response: { result: { type: "customer", value: 9 } } } }] },
    ],
    tools: [{ functionDeclarations: [{ name: "task", parametersJsonSchema: { type: "object", properties: { type: { type: "string" } }, additionalProperties: false } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["task"] } },
    generationConfig: { maxOutputTokens: 2048, temperature: 0, seed: 7, thinkingConfig: { thinking_level: "HIGH", include_thoughts: false } },
    cachedContent: "cachedContents/fixture",
    labels: { trace: "fixture" },
    // A hypothetical future opaque extension: this is not a claim about a
    // currently supported subagent protocol or its actual field names.
    futureInitialization: { task: "fixture", args: { type: "customer" } },
  };
}
let context;
let services;
function load() {
  services = {
    getSettings: vi.fn().mockResolvedValue({ requireApiKey: true }),
    isValidApiKey: vi.fn().mockImplementation(async key => key === "router-key"),
    getKeyAccessContext: vi.fn(async () => null),
    enforceKeyAccess: vi.fn(async () => null),
    enforceKeyAccessResolved: vi.fn(async () => null),
    filterAdapterModels: vi.fn(async (_keyAccess, models) => models),
    getProviderCredentials: vi.fn().mockResolvedValue({ apiKey: "provider-key", connectionId: "fixture-connection", providerSpecificData: {} }),
    markAccountUnavailable: vi.fn().mockResolvedValue({ shouldFallback: false }),
    clearAccountError: vi.fn().mockResolvedValue(undefined),
    handleChatCore: vi.fn().mockImplementation(async () => ({ success: true, response: Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }) })),
    fetch: vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/pcm", data: "AA==" } }] } }] })),
  };
  const quiet = Object.fromEntries(["log", "debug", "warn", "error", "info"].map(k => [k, () => {}]));
  quiet.maskKey = () => "masked-test-key";
  context = {
    ...services, console: quiet, log: quiet,
    Request, Response, Headers, URL, Buffer, AbortController, ReadableStream,
    TextEncoder, TextDecoder, TransformStream, setTimeout, clearTimeout,
    GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS: 50,
    PROVIDER_MODELS: { gemini: [], "gemini-tts-models": [] },
    initTranslators: async () => {},
    HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, SERVICE_UNAVAILABLE: 503 },
    FORMATS: { GEMINI: "gemini", OPENAI: "openai" },
    DEFAULT_HEADROOM_URL: "http://unused.test",
    getComboModels: async () => null,
    getTargetFormat: provider => ["gemini", "aistudio"].includes(provider) ? "gemini" : "openai",
    proxyAwareFetch: (...args) => services.fetch(...args),
    getModelInfo: async model => { const i = model.indexOf("/"); return { provider: i < 0 ? "gemini" : model.slice(0, i), model: i < 0 ? model : model.slice(i + 1) }; },
    stripModelContextMarker: model => ({ model, contextMarker: null }),
    detectRequiredCapabilities: () => new Set(),
    augmentModelsWithCapacityAdapter: models => models,
    handleBypassRequest: () => null,
    checkAndRefreshToken: async (_provider, credentials) => credentials,
    clearAntigravityStrikes: () => {},
    getPxpipeTransform: async () => null,
    appendPxpipeEvent: () => {},
    detectFormatByEndpoint: () => null,
    upstreamResponseHeaders: headers => Object.fromEntries(headers || []),
    updateProviderCredentials: async () => {},
    errorResponse: (status, message, headers) => Response.json({ error: { message } }, { status, headers }),
    unavailableResponse: (status, message) => Response.json({ error: { message } }, { status }),
  };
  vm.createContext(context);
  // Reuse the real key extraction implementation, not a permissive test copy.
  const auth = fs.readFileSync(path.join(root, "src/sse/services/auth.js"), "utf8");
  const start = auth.indexOf("export function extractApiKey(");
  const end = auth.indexOf("/**", start);
  vm.runInContext(auth.slice(start, end).replace("export ", ""), context);
  vm.runInContext(moduleSource("src/sse/handlers/chat.js"), context);
  vm.runInContext(moduleSource("src/app/api/v1beta/models/[...path]/route.js"), context);
}
function request(provider, action, body = nativeBody(), { headers = { Authorization: "Bearer router-key" }, query = "", signal } = {}) {
  const model = "gemini-3.5-flash-lite(high)";
  const url = `https://router.test/v1beta/models/${provider}/${model}:${action}${query}`;
  const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  return { req, params: { params: Promise.resolve({ path: [provider, `${model}:${action}`] }) } };
}
async function call(provider, action, body, options) {
  const { req, params } = request(provider, action, body, options);
  const response = await context.POST(req, params);
  if (response.status === 500) throw new Error(await response.clone().text());
  return response;
}

describe("native Gemini endpoint entry contract", () => {
  beforeEach(load);

  for (const provider of ["gemini", "aistudio"]) {
    it(`${provider}: preserves native tool history, settings and arbitrary opaque extensions`, async () => {
      const original = nativeBody();
      const response = await call(provider, "generateContent", original);
      expect(response.status).toBe(200);
      expect(services.handleChatCore).toHaveBeenCalledTimes(1);
      const options = services.handleChatCore.mock.calls[0][0];
      for (const [key, value] of Object.entries(original)) expect(options.body[key], key).toEqual(value);
      expect(options.modelInfo.provider).toBe(provider);
      expect(options.body.model).toBe(`${provider}/gemini-3.5-flash-lite(high)`);
      expect(options.sourceFormatOverride).toBe("gemini");
      expect(options.body.stream).toBe(false);
      expect(services.fetch).not.toHaveBeenCalled();
    });

    for (const auth of ["google-header", "query", "query-alias", "bearer"]) {
      it(`${provider}: accepts ${auth} router credentials before selecting a provider`, async () => {
        const options = auth === "google-header" ? { headers: { "x-goog-api-key": "router-key" } }
          : auth === "query" ? { headers: {}, query: "?key=router-key" }
          : auth === "query-alias" ? { headers: {}, query: "?$key=router-key" }
          : { headers: { Authorization: "Bearer router-key" } };
        const response = await call(provider, "generateContent", nativeBody(), options);
        expect(response.status).toBe(200);
        expect(services.isValidApiKey).toHaveBeenCalledWith("router-key");
        expect(services.handleChatCore).toHaveBeenCalledTimes(1);
      });
    }

    it(`${provider}: rejects a bad Google-style router credential without provider calls`, async () => {
      const response = await call(provider, "generateContent", nativeBody(), { headers: { "x-goog-api-key": "invalid" } });
      expect(response.status).toBe(401);
      expect(services.handleChatCore).not.toHaveBeenCalled();
      expect(services.getProviderCredentials).not.toHaveBeenCalled();
    });

    it(`${provider}: malformed JSON is a non-retryable native client error without provider calls`, async () => {
      const req = new Request(`https://router.test/v1beta/models/${provider}/gemini-3.5-flash-lite:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer router-key" }, body: '{"contents":[',
      });
      const response = await context.POST(req, { params: Promise.resolve({ path: [provider, "gemini-3.5-flash-lite:generateContent"] }) });
      expect(response.status).toBe(400);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Request body is not valid JSON" } });
      expect(services.getProviderCredentials).not.toHaveBeenCalled();
      expect(services.handleChatCore).not.toHaveBeenCalled();
      expect(services.fetch).not.toHaveBeenCalled();
    });

    it(`${provider}: action determines streaming and provider-native frames return unchanged`, async () => {
      const payload = 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call-1","name":"task","args":{"value":9}},"thoughtSignature":"fixture"}]}}]}\n\ndata: {"usageMetadata":{"cachedContentTokenCount":4096}}\n\n';
      services.handleChatCore.mockImplementationOnce(async options => ({ success: true, response: new Response(payload, { headers: { "Content-Type": "text/event-stream" } }) }));
      const response = await call(provider, "streamGenerateContent");
      expect(services.handleChatCore.mock.calls[0][0].body.stream).toBe(true);
      expect(await response.text()).toBe(payload);
    });

    it(`${provider}: client abort remains connected to the core provider signal`, async () => {
      const abort = new AbortController();
      await call(provider, "generateContent", nativeBody(), { signal: abort.signal });
      const options = services.handleChatCore.mock.calls[0][0];
      expect(options.clientSignal).toBeDefined();
      expect(options.clientSignal.aborted).toBe(false);
      abort.abort();
      expect(options.clientSignal.aborted).toBe(true);
    });

    it(`${provider}: native error category/details and Retry-After survive an exhausted account fallback`, async () => {
      const error = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "fixture quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" }] } };
      services.getProviderCredentials.mockResolvedValueOnce({ apiKey: "provider-key", connectionId: "fixture-connection", providerSpecificData: {} }).mockResolvedValueOnce(null);
      services.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
      services.handleChatCore.mockResolvedValueOnce({ success: false, status: 429, error: "fixture quota", nativeResponse: true, response: Response.json(error, { status: 429, headers: { "Retry-After": "17" } }) });
      const response = await call(provider, "generateContent");
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("17");
      expect(await response.json()).toEqual(error);
    });

    for (const [first, second] of [["account-a", "account-b"], ["account-b", "account-a"]]) {
      it(`${provider}: ${first} to ${second} fallback preserves signed tool history and native settings`, async () => {
        const original = nativeBody();
        const credentials = id => ({ apiKey: `fixture-${id}-key`, connectionId: id, providerSpecificData: {} });
        services.getProviderCredentials.mockReset()
          .mockResolvedValueOnce(credentials(first))
          .mockResolvedValueOnce(credentials(second));
        services.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
        services.handleChatCore
          .mockResolvedValueOnce({ success: false, status: 429, error: "fixture quota", nativeResponse: true, response: Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 }) })
          .mockImplementationOnce(async options => {
            await options.onRequestSuccess();
            return { success: true, response: Response.json({ candidates: [{ content: { parts: [{ text: "continued tool task" }] }, finishReason: "STOP" }] }) };
          });
        const response = await call(provider, "generateContent", original, { query: "?fields=candidates" });
        expect(response.status).toBe(200);
        expect((await response.json()).candidates[0].content.parts[0].text).toBe("continued tool task");
        expect(services.handleChatCore).toHaveBeenCalledTimes(2);
        const attempts = services.handleChatCore.mock.calls.map(([options]) => options);
        expect(attempts.map(options => options.connectionId)).toEqual([first, second]);
        for (const options of attempts) {
          expect(options.sourceFormatOverride).toBe("gemini");
          expect(options.body).toEqual({ ...original, model: `${provider}/gemini-3.5-flash-lite(high)`, stream: false });
          expect(options.clientRawRequest.body).toEqual(original);
          expect(options.clientRawRequest.queryParams).toEqual([["fields", "candidates"]]);
        }
        expect(services.getProviderCredentials.mock.calls[1][1].has(first)).toBe(true);
        expect(services.markAccountUnavailable).toHaveBeenCalledTimes(1);
        expect(services.markAccountUnavailable.mock.calls[0][0]).toBe(first);
        expect(services.clearAccountError.mock.calls[0][0]).toBe(second);
      });
    }
  }

  it("Gemini AUDIO abort after fetch headers cancels the existing native upstream operation", async () => {
    const abort = new AbortController();
    const audio = { contents: [{ parts: [{ text: "Speak" }] }], generationConfig: { responseModalities: ["AUDIO"] } };
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"candidates":[]}\n\n')); } });
    services.fetch.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const req = new Request("https://router.test/v1beta/models/gemini/tts-model:streamGenerateContent", { method: "POST", headers: { Authorization: "Bearer router-key", "Content-Type": "application/json" }, body: JSON.stringify(audio), signal: abort.signal });
    const response = await context.POST(req, { params: Promise.resolve({ path: ["gemini", "tts-model:streamGenerateContent"] }) });
    expect(response.status).toBe(200);
    expect(services.fetch).toHaveBeenCalledTimes(1);
    const signal = services.fetch.mock.calls[0][1].signal;
    abort.abort();
    expect(signal.aborted).toBe(true);
    await response.body.cancel();
  });

  it("a foreign-provider request keeps the existing translated route", async () => {
    const response = await call("openai", "generateContent", { contents: [{ role: "user", parts: [{ text: "hello" }] }] });
    expect(response.status).toBe(200);
    const options = services.handleChatCore.mock.calls[0][0];
    expect(options.modelInfo.provider).toBe("openai");
    expect(options.body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(services.fetch).not.toHaveBeenCalled();
  });
});
