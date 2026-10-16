// Kept outside the inherited stable-version contract: trusted-test overlays
// must not erase alpha entry, provider resolution, or route-graph coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";

const mocks = vi.hoisted(() => ({ network: vi.fn(), handleChat: vi.fn() }));
vi.mock("../../src/app/api/v1/models/route.js", () => ({ buildModelsList: async () => [] }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.network }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: async value => {
  const slash = value.indexOf("/");
  return slash < 0 ? { provider: "gemini", model: value } : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
} }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ apiKey: "fixture-provider-key", connectionId: "fixture", providerSpecificData: {} }),
  isValidApiKey: async () => true, markAccountUnavailable: async () => ({ shouldFallback: false }), clearAccountError: async () => {},
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: true }) }));
vi.mock("../../open-sse/executors/index.js", async () => {
  const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
  return { getExecutor: provider => new DefaultExecutor(provider) };
});
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => new Proxy({}, { get: (_target, key) => key === "then" ? undefined : vi.fn() }) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/lib/db/helpers/kvStore.js", () => ({ makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }) }));

const alpha = await import("../../src/app/api/v1alpha/models/[...path]/route.js");
const stable = await import("../../src/app/api/v1/models/[...model]/route.js");
const beta = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const model = "gemini-3.5-flash-lite";
const input = { contents: [{ role: "user", parts: [{ text: "Alpha task" }] }], generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } }, futureTask: { type: "customer", args: [3] } };
const reply = { candidates: [{ content: { role: "model", parts: [{ text: "ALPHA_OK" }] }, finishReason: "STOP" }] };
let credentials;

describe("native Gemini alpha generation contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("DIRECT_NETWORK_FORBIDDEN"); }));
    mocks.network.mockImplementation(async (_url, options) => new Response(JSON.stringify(options.headers.Accept ? [reply] : reply), { headers: { "Content-Type": "application/json" } }));
    mocks.handleChat.mockImplementation(async (request, raw, options) => {
      const body = await request.json();
      const slash = body.model.indexOf("/");
      const provider = slash < 0 ? "gemini" : body.model.slice(0, slash);
      const selectedModel = slash < 0 ? body.model : body.model.slice(slash + 1);
      credentials = { apiKey: "fixture-provider-key", connectionId: "fixture", providerSpecificData: {} };
      const result = await handleChatCore({ body, modelInfo: { provider, model: selectedModel }, credentials,
        sourceFormatOverride: options.sourceFormatOverride, clientRawRequest: raw, clientSignal: request.signal,
        connectionId: "fixture", userAgent: "native-alpha-test", providerThinking: { mode: "high" },
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return result.response;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shares the actual native POST/OPTIONS and contains only one active alpha catch-all", () => {
    expect(alpha.POST).toBe(beta.POST);
    expect(alpha.OPTIONS).toBe(beta.OPTIONS);
    const directory = new URL("../../src/app/api/v1alpha/models/", import.meta.url);
    const routes = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\[\.\.\..+\]$/.test(entry.name))
      .filter(entry => existsSync(new URL(`${entry.name}/route.js`, directory))).map(entry => entry.name);
    expect(routes).toEqual(["[...path]"]);
  });

  it("keeps the live browser-auth v1 404 regression protected from inherited test overlays", async () => {
    const savedError = { error: { code: 404, status: "INTERNAL", message: 'Proxy browser error: Google API returned error: 404 NOT_FOUND {"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}' } };
    mocks.network.mockImplementation(async url => new URL(url).pathname.startsWith("/v1/models/")
      ? Response.json(savedError, { status: 404 }) : Response.json(reply));
    const request = new Request(`https://router.test/v1/models/aistudio/${model}:generateContent?$key=fixture-client-key&fields=candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const response = await stable.POST(request, { params: Promise.resolve({ model: ["aistudio", `${model}:generateContent`] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    expect(mocks.handleChat.mock.calls[0][1].apiVersion).toBe("v1");
    expect(credentials.nativeGeminiRequest.apiVersion).toBe("v1beta");
    expect(new URL(mocks.network.mock.calls[0][0]).pathname).toBe(`/v1beta/models/${model}:generateContent`);
    expect(JSON.parse(mocks.network.mock.calls[0][1].body)).toEqual(input);
    expect(mocks.network).toHaveBeenCalledOnce();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  for (const provider of ["gemini", "aistudio"]) {
    it(`${provider}: the generic executor formats an explicitly resolved alpha version`, () => {
      const executor = new DefaultExecutor(provider);
      const url = executor.buildUrl(model, false, 0, { nativeGeminiPassthrough: true, nativeGeminiRequest: { apiVersion: "v1alpha" } });
      expect(new URL(url).pathname).toBe(`/v1alpha/models/${model}:generateContent`);
    });

    for (const action of ["generateContent", "streamGenerateContent"]) {
      it(`${provider}: actual alpha POST and core resolve the provider wire while retaining client version/body`, async () => {
        const request = new Request(`https://router.test/v1alpha/models/${provider}/${model}:${action}?$key=fixture-client-key&fields=candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
        const response = await alpha.POST(request, { params: Promise.resolve({ path: [provider, `${model}:${action}`] }) });
        expect(response.status).toBe(200);
        await response.text();
        expect(mocks.handleChat).toHaveBeenCalledOnce();
        const [, raw, options] = mocks.handleChat.mock.calls[0];
        expect(raw.apiVersion).toBe("v1alpha");
        expect(raw.body).toEqual(input);
        expect(raw.queryParams).toEqual([["fields", "candidates"]]);
        expect(options.stream).toBe(action === "streamGenerateContent");
        const wireVersion = provider === "aistudio" ? "v1beta" : "v1alpha";
        expect(credentials.nativeGeminiRequest.apiVersion).toBe(wireVersion);
        expect(new URL(mocks.network.mock.calls[0][0]).pathname).toBe(`/${wireVersion}/models/${model}:${action}`);
        expect(JSON.parse(mocks.network.mock.calls[0][1].body)).toEqual(input);
        expect(mocks.network).toHaveBeenCalledOnce();
        expect(global.fetch).not.toHaveBeenCalled();
      });
    }
  }
});
