import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const stub = vi.hoisted(() => ({
  fetchCalls: [],
  proxyCalls: [],
  proxyMode: "ok",
  connection: null,
  connections: [],
  customModels: [],
  updated: [],
  proxyConfig: { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:3128" },
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options, proxyOptions) => {
    stub.proxyCalls.push({ url: String(url), options, proxyOptions });
    if (stub.proxyMode === "native-gemini") {
      const reply = { candidates: [{ content: { role: "model", parts: [{ text: "AG2_OK" }] }, finishReason: "STOP" }] };
      const isSse = options?.headers?.Accept === "text/event-stream";
      return new Response(
        isSse ? `data: ${JSON.stringify(reply)}\r\n\r\n` : JSON.stringify(reply),
        { status: 200, headers: { "Content-Type": isSse ? "text/event-stream" : "application/json" } },
      );
    }
    if (stub.proxyMode === "empty") return Response.json({ data: [] });
    if (stub.proxyMode === "unauthorized") return new Response("denied", { status: 401 });
    if (stub.proxyMode === "forbidden") return new Response("denied", { status: 403 });
    if (stub.proxyMode === "reject") throw new Error("bridge offline");
    return Response.json({
      object: "list",
      data: [{ id: "gemini-4-argon" }, { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }, { id: "" }],
    });
  },
  default: async () => { throw new Error("patched fetch must not run"); },
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: async () => stub.connection,
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: async () => stub.connection,
  updateProviderConnection: async (id, data) => { stub.updated.push({ id, data }); },
  getProviderConnections: async () => stub.connections || [],
  getCombos: async () => [],
  getCustomModels: async () => stub.customModels || [],
  getModelAliases: async () => ({}),
  getSettings: async () => ({ requireApiKey: false }),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => stub.proxyConfig || {},
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: async () => ({ ok: true }) }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  filterModelsListForKey: async (_ctx, data) => data,
  extractClientApiKey: () => null,
  enforceKeyAccessResolved: async () => null,
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : vi.fn()) }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }),
}));

const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
const { PROVIDERS } = await import("../../open-sse/config/providers.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { getModelInfoCore } = await import("../../open-sse/services/model.js");
const { getTargetFormat, supportsNativeGemini } = await import("../../open-sse/services/provider.js");
const { resolveAIStudioModels } = await import("../../open-sse/services/aistudioModels.js");
const { initTranslators } = await import("../../open-sse/translator/index.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { resolveProviderIconId } = await import("../../src/shared/utils/providerIcon.js");
const validateRoute = await import("../../src/app/api/providers/validate/route.js");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const dashboardModels = await import("../../src/app/api/providers/[id]/models/route.js");
const v1Models = await import("../../src/app/api/v1/models/route.js");

await initTranslators();

const MODEL = "gemini-4-argon";
const EXPECT_PLAIN_HEADERS = { "Content-Type": "application/json", "x-goog-api-key": "ag2-bridge-key" };
const EXPECT_SSE_HEADERS = { ...EXPECT_PLAIN_HEADERS, Accept: "text/event-stream" };

beforeEach(() => {
  stub.fetchCalls = [];
  stub.proxyCalls = [];
  stub.proxyMode = "ok";
  stub.connection = null;
  stub.connections = [];
  stub.customModels = [];
  stub.updated = [];
  stub.proxyConfig = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:3128" };
  vi.stubGlobal("fetch", async (...args) => {
    stub.fetchCalls.push(args);
    return new Response("ok", { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("antigravity2api local Gemini bridge contract", () => {
  it("registers antigravity2api without altering upstream antigravity OAuth provider", () => {
    const ag2Entry = REGISTRY.find((entry) => entry.id === "antigravity2api");
    const upstreamAntigravity = REGISTRY.find((entry) => entry.id === "antigravity");

    expect(ag2Entry).toBeTruthy();
    expect(ag2Entry.display.name).toBe("Antigravity2API");
    expect(ag2Entry.display.website).toBe("https://github.com/Mag1cFall/Antigravity2API");
    expect(ag2Entry.display.notice.text).toContain("127.0.0.1:8017");
    expect(ag2Entry.display.notice.text).toContain("API_KEYS");
    expect(ag2Entry.passthroughModels).toBe(true);
    expect(ag2Entry.models).toEqual([]);

    expect(upstreamAntigravity.category).toBe("oauth");
    expect(upstreamAntigravity.transport.format).toBe("antigravity");

    expect(PROVIDERS["antigravity2api"].format).toBe(FORMATS.GEMINI);
    expect(getTargetFormat("antigravity2api", {})).toBe("gemini");
    expect(supportsNativeGemini("antigravity2api", MODEL)).toBe(true);
    expect(PROVIDERS["antigravity2api"].clientId).toBeUndefined();
    expect(PROVIDERS["antigravity2api"].clientSecret).toBeUndefined();
    expect(resolveProviderIconId("antigravity2api")).toBe("antigravity");
  });

  it("locks streaming and non-streaming URLs, headers, aliases, and path-traversal safety", async () => {
    const executor = new DefaultExecutor("antigravity2api");
    expect(PROVIDERS["antigravity2api"].baseUrl).toBe("http://127.0.0.1:8017/v1beta/models");
    expect(executor.buildUrl(MODEL, false, 0, {})).toBe(`http://127.0.0.1:8017/v1beta/models/${MODEL}:generateContent`);
    expect(executor.buildUrl(MODEL, true, 0, {})).toBe(`http://127.0.0.1:8017/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`);

    expect(executor.buildHeaders({ apiKey: "ag2-bridge-key" }, false, executor.buildUrl(MODEL, false, 0, {}), MODEL))
      .toEqual(EXPECT_PLAIN_HEADERS);
    expect(executor.buildHeaders({ apiKey: "ag2-bridge-key" }, true, executor.buildUrl(MODEL, true, 0, {}), MODEL))
      .toEqual(EXPECT_SSE_HEADERS);

    for (const prefix of ["antigravity2api", "ag2"]) {
      const info = await getModelInfoCore(`${prefix}/${MODEL}`, {});
      expect(info.provider).toBe("antigravity2api");
      expect(info.model).toBe(MODEL);
    }

    for (const [raw, normalized] of [["../../admin?x=1", "../../admin?x=1"], ["%2e%2e%2fadmin", "%2e%2e%2fadmin"], ["модель/模型", "модель/模型"]]) {
      for (const stream of [false, true]) {
        const url = new URL(executor.buildUrl(raw, stream, 0, {}));
        const action = stream ? ":streamGenerateContent" : ":generateContent";
        expect(url.origin).toBe("http://127.0.0.1:8017");
        expect(url.pathname.startsWith("/v1beta/models/")).toBe(true);
        expect(url.pathname.endsWith(action)).toBe(true);
        const segment = url.pathname.slice("/v1beta/models/".length, -action.length);
        expect(segment).not.toContain("/");
        expect(decodeURIComponent(segment)).toBe(normalized);
      }
    }
  });

  it("discovers models and validates credentials against 127.0.0.1:8017/v1/models with error propagation", async () => {
    const discovered = await resolveAIStudioModels(
      { apiKey: "ag2-key" },
      { provider: "antigravity2api", proxyOptions: stub.proxyConfig },
    );
    expect(stub.proxyCalls).toHaveLength(1);
    expect(stub.proxyCalls[0].url).toBe("http://127.0.0.1:8017/v1/models");
    expect(stub.proxyCalls[0].options.headers.Authorization).toBe("Bearer ag2-key");
    expect(discovered.models.map((m) => m.id)).toEqual(["gemini-4-argon", "claude-sonnet-5-5"]);
    expect(discovered.models[1].name).toBe("Claude Sonnet 5.5");

    expect(await resolveAIStudioModels({ apiKey: "ag2-key" }, { provider: "nonexistent-provider" }))
      .toMatchObject({ status: 400 });

    const validRes = await validateRoute.POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "antigravity2api", apiKey: "ag2-key" }),
    }));
    expect((await validRes.json()).valid).toBe(true);
    expect(String(stub.fetchCalls[0][0])).toBe("http://127.0.0.1:8017/v1/models");
    expect(stub.fetchCalls[0][1].headers.Authorization).toBe("Bearer ag2-key");

    vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
    const deniedRes = await validateRoute.POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "antigravity2api", apiKey: "bad-key" }),
    }));
    expect((await deniedRes.json()).valid).toBe(false);

    stub.proxyCalls = [];
    stub.connection = { id: "c-ag2", provider: "antigravity2api", authType: "apikey", apiKey: "ag2-key", providerSpecificData: {} };
    expect(await testSingleConnection("c-ag2")).toMatchObject({ valid: true, error: null });
    expect(stub.proxyCalls[0].url).toBe("http://127.0.0.1:8017/v1/models");

    stub.proxyMode = "forbidden";
    expect(await testSingleConnection("c-ag2")).toMatchObject({ valid: false, error: "Invalid API key" });

    stub.proxyMode = "ok";
    stub.proxyCalls = [];
    const dashRes = await dashboardModels.GET(
      new Request("http://localhost/api/providers/c-ag2/models"),
      { params: Promise.resolve({ id: "c-ag2" }) },
    );
    expect(dashRes.status).toBe(200);
    expect((await dashRes.json()).models.map((m) => m.id)).toContain("gemini-4-argon");

    stub.proxyCalls = [];
    stub.connections = [{ id: "c-ag2", provider: "antigravity2api", authType: "apikey", apiKey: "ag2-key", isActive: true, providerSpecificData: {} }];
    const v1List = await v1Models.buildModelsList(["llm"]);
    expect(stub.proxyCalls).toHaveLength(1);
    expect(v1List.some((row) => row.id === "antigravity2api/gemini-4-argon")).toBe(true);
  });

  it("routes native Gemini v1, v1beta, and v1alpha requests (stream + non-stream) onto 127.0.0.1:8017/v1beta without rewriting responseJsonSchema", async () => {
    stub.proxyMode = "native-gemini";
    const nativeInput = {
      contents: [{ role: "user", parts: [{ text: "Return JSON" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false },
      },
    };

    for (const clientApiVersion of ["v1", "v1beta", "v1alpha"]) {
      for (const stream of [false, true]) {
        stub.proxyCalls = [];
        const credentials = { apiKey: "ag2-bridge-key", connectionId: "c-ag2", providerSpecificData: {} };
        const result = await handleChatCore({
          body: { ...nativeInput, model: `antigravity2api/${MODEL}`, stream },
          modelInfo: { provider: "antigravity2api", model: MODEL },
          credentials,
          sourceFormatOverride: "gemini",
          clientRawRequest: {
            apiVersion: clientApiVersion,
            body: nativeInput,
            headers: {},
            queryParams: stream
              ? [["alt", "sse"], ["key", "client-secret"], ["fields", "candidates"]]
              : [["$key", "client-secret"], ["fields", "candidates"]],
          },
          connectionId: "c-ag2",
          userAgent: "ag2-native-test",
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        expect(result.response.status).toBe(200);
        await result.response.text();
        expect(credentials.nativeGeminiRequest.apiVersion).toBe("v1beta");
        expect(stub.proxyCalls).toHaveLength(1);
        const upstreamUrl = new URL(stub.proxyCalls[0].url);
        expect(upstreamUrl.origin).toBe("http://127.0.0.1:8017");
        expect(upstreamUrl.pathname).toBe(`/v1beta/models/${MODEL}:${stream ? "streamGenerateContent" : "generateContent"}`);
        expect(upstreamUrl.searchParams.has("key")).toBe(false);
        expect(upstreamUrl.searchParams.has("$key")).toBe(false);
        expect(upstreamUrl.searchParams.get("fields")).toBe("candidates");
        expect(stub.proxyCalls[0].options.headers["x-goog-api-key"]).toBe("ag2-bridge-key");
        const sentBody = JSON.parse(stub.proxyCalls[0].options.body);
        expect(sentBody.generationConfig.responseJsonSchema).toEqual(nativeInput.generationConfig.responseJsonSchema);
        expect(sentBody.generationConfig.responseFormat).toBeUndefined();
      }
    }
  });

});
