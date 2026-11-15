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
      const reply = { candidates: [{ content: { role: "model", parts: [{ text: "G2A_OK" }] }, finishReason: "STOP" }] };
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
      data: [{ id: "gemini-4-hydrogen" }, { id: "gemini-3.5-flash-lite", display_name: "Gemini 3.5 Flash Lite" }, { id: "" }],
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
const { initTranslators, translateRequest } = await import("../../open-sse/translator/index.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { resolveProviderIconId } = await import("../../src/shared/utils/providerIcon.js");
const validateRoute = await import("../../src/app/api/providers/validate/route.js");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const dashboardModels = await import("../../src/app/api/providers/[id]/models/route.js");
const v1Models = await import("../../src/app/api/v1/models/route.js");

await initTranslators();

const MODEL = "gemini-4-hydrogen";
const EXPECT_PLAIN_HEADERS = { "Content-Type": "application/json", "x-goog-api-key": "g2a-bridge-key" };
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

describe("gemini-web2api and aistudio local Gemini bridge contracts", () => {
  it("registers gemini-web2api without altering upstream gemini-web and updates aistudio metadata to AIStudio2API", () => {
    const g2aEntry = REGISTRY.find((entry) => entry.id === "gemini-web2api");
    const aistudioEntry = REGISTRY.find((entry) => entry.id === "aistudio");
    const upstreamGeminiWeb = REGISTRY.find((entry) => entry.id === "gemini-web");

    expect(g2aEntry).toBeTruthy();
    expect(g2aEntry.display.name).toBe("Gemini-Web2API");
    expect(g2aEntry.display.website).toBe("https://github.com/Mag1cFall/Gemini-Web2API");
    expect(g2aEntry.display.notice.text).toContain("127.0.0.1:8007");
    expect(g2aEntry.display.notice.text).toContain("PROXY_API_KEY");
    expect(g2aEntry.passthroughModels).toBe(true);
    expect(g2aEntry.models).toEqual([]);

    expect(aistudioEntry.display.name).toBe("AIStudio2API");
    expect(aistudioEntry.display.website).toBe("https://github.com/Mag1cFall/AIStudio2API");
    expect(aistudioEntry.display.notice.text).toContain("PROXY_API_KEY");

    expect(upstreamGeminiWeb.category).toBe("webCookie");
    expect(upstreamGeminiWeb.transport.baseUrl).toBe("https://gemini.google.com/app");

    expect(PROVIDERS["gemini-web2api"].format).toBe(FORMATS.GEMINI);
    expect(getTargetFormat("gemini-web2api", {})).toBe("gemini");
    expect(supportsNativeGemini("gemini-web2api", MODEL)).toBe(true);
    expect(PROVIDERS["gemini-web2api"].clientId).toBeUndefined();
    expect(PROVIDERS["gemini-web2api"].clientSecret).toBeUndefined();
    expect(resolveProviderIconId("gemini-web2api")).toBe("gemini");
    expect(resolveProviderIconId("aistudio")).toBe("gemini");
  });

  it("locks streaming and non-streaming URLs, headers, aliases, and path-traversal safety", async () => {
    const executor = new DefaultExecutor("gemini-web2api");
    expect(PROVIDERS["gemini-web2api"].baseUrl).toBe("http://127.0.0.1:8007/v1beta/models");
    expect(executor.buildUrl(MODEL, false, 0, {})).toBe(`http://127.0.0.1:8007/v1beta/models/${MODEL}:generateContent`);
    expect(executor.buildUrl(MODEL, true, 0, {})).toBe(`http://127.0.0.1:8007/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`);

    expect(executor.buildHeaders({ apiKey: "g2a-bridge-key" }, false, executor.buildUrl(MODEL, false, 0, {}), MODEL))
      .toEqual(EXPECT_PLAIN_HEADERS);
    expect(executor.buildHeaders({ apiKey: "g2a-bridge-key" }, true, executor.buildUrl(MODEL, true, 0, {}), MODEL))
      .toEqual(EXPECT_SSE_HEADERS);

    for (const prefix of ["gemini-web2api", "g2a"]) {
      const info = await getModelInfoCore(`${prefix}/${MODEL}`, {});
      expect(info.provider).toBe("gemini-web2api");
      expect(info.model).toBe(MODEL);
    }

    for (const [raw, normalized] of [["../../admin?x=1", "../../admin?x=1"], ["%2e%2e%2fadmin", "%2e%2e%2fadmin"], ["модель/模型", "модель/模型"]]) {
      for (const stream of [false, true]) {
        const url = new URL(executor.buildUrl(raw, stream, 0, {}));
        const action = stream ? ":streamGenerateContent" : ":generateContent";
        expect(url.origin).toBe("http://127.0.0.1:8007");
        expect(url.pathname.startsWith("/v1beta/models/")).toBe(true);
        expect(url.pathname.endsWith(action)).toBe(true);
        const segment = url.pathname.slice("/v1beta/models/".length, -action.length);
        expect(segment).not.toContain("/");
        expect(decodeURIComponent(segment)).toBe(normalized);
      }
    }
  });

  it("discovers models and validates credentials against 127.0.0.1:8007/v1/models with error propagation", async () => {
    const discovered = await resolveAIStudioModels(
      { apiKey: "g2a-key" },
      { provider: "gemini-web2api", proxyOptions: stub.proxyConfig },
    );
    expect(stub.proxyCalls).toHaveLength(1);
    expect(stub.proxyCalls[0].url).toBe("http://127.0.0.1:8007/v1/models");
    expect(stub.proxyCalls[0].options.headers.Authorization).toBe("Bearer g2a-key");
    expect(discovered.models.map((m) => m.id)).toEqual(["gemini-4-hydrogen", "gemini-3.5-flash-lite"]);
    expect(discovered.models[1].name).toBe("Gemini 3.5 Flash Lite");

    expect(await resolveAIStudioModels({ apiKey: "g2a-key" }, { provider: "nonexistent-provider" }))
      .toMatchObject({ status: 400 });

    const validRes = await validateRoute.POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "gemini-web2api", apiKey: "g2a-key" }),
    }));
    expect((await validRes.json()).valid).toBe(true);
    expect(String(stub.fetchCalls[0][0])).toBe("http://127.0.0.1:8007/v1/models");
    expect(stub.fetchCalls[0][1].headers.Authorization).toBe("Bearer g2a-key");

    vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
    const deniedRes = await validateRoute.POST(new Request("http://localhost/api/providers/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "gemini-web2api", apiKey: "bad-key" }),
    }));
    expect((await deniedRes.json()).valid).toBe(false);

    stub.proxyCalls = [];
    stub.connection = { id: "c-g2a", provider: "gemini-web2api", authType: "apikey", apiKey: "g2a-key", providerSpecificData: {} };
    expect(await testSingleConnection("c-g2a")).toMatchObject({ valid: true, error: null });
    expect(stub.proxyCalls[0].url).toBe("http://127.0.0.1:8007/v1/models");

    stub.proxyMode = "forbidden";
    expect(await testSingleConnection("c-g2a")).toMatchObject({ valid: false, error: "Invalid API key" });

    stub.proxyMode = "ok";
    stub.proxyCalls = [];
    const dashRes = await dashboardModels.GET(
      new Request("http://localhost/api/providers/c-g2a/models"),
      { params: Promise.resolve({ id: "c-g2a" }) },
    );
    expect(dashRes.status).toBe(200);
    expect((await dashRes.json()).models.map((m) => m.id)).toContain("gemini-4-hydrogen");

    stub.proxyCalls = [];
    stub.connections = [{ id: "c-g2a", provider: "gemini-web2api", authType: "apikey", apiKey: "g2a-key", isActive: true, providerSpecificData: {} }];
    const v1List = await v1Models.buildModelsList(["llm"]);
    expect(stub.proxyCalls).toHaveLength(1);
    expect(v1List.some((row) => row.id === "gemini-web2api/gemini-4-hydrogen")).toBe(true);
  });

  it("routes native Gemini v1, v1beta, and v1alpha requests (stream + non-stream) onto 127.0.0.1:8007/v1beta without rewriting responseJsonSchema", async () => {
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
        const credentials = { apiKey: "g2a-bridge-key", connectionId: "c-g2a", providerSpecificData: {} };
        const result = await handleChatCore({
          body: { ...nativeInput, model: `gemini-web2api/${MODEL}`, stream },
          modelInfo: { provider: "gemini-web2api", model: MODEL },
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
          connectionId: "c-g2a",
          userAgent: "g2a-native-test",
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        expect(result.response.status).toBe(200);
        await result.response.text();
        expect(credentials.nativeGeminiRequest.apiVersion).toBe("v1beta");
        expect(stub.proxyCalls).toHaveLength(1);
        const upstreamUrl = new URL(stub.proxyCalls[0].url);
        expect(upstreamUrl.origin).toBe("http://127.0.0.1:8007");
        expect(upstreamUrl.pathname).toBe(`/v1beta/models/${MODEL}:${stream ? "streamGenerateContent" : "generateContent"}`);
        expect(upstreamUrl.searchParams.has("key")).toBe(false);
        expect(upstreamUrl.searchParams.has("$key")).toBe(false);
        expect(upstreamUrl.searchParams.get("fields")).toBe("candidates");
        expect(stub.proxyCalls[0].options.headers["x-goog-api-key"]).toBe("g2a-bridge-key");
        const sentBody = JSON.parse(stub.proxyCalls[0].options.body);
        expect(sentBody.generationConfig.responseJsonSchema).toEqual(nativeInput.generationConfig.responseJsonSchema);
        expect(sentBody.generationConfig.responseFormat).toBeUndefined();
      }
    }
  });

  it("translates Responses web_search to googleSearch without includeServerSideToolInvocations on gemini-web2api", () => {
    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.GEMINI,
      MODEL,
      {
        model: `gemini-web2api/${MODEL}`,
        input: [{ role: "user", content: [{ type: "input_text", text: "Search latest docs" }] }],
        tools: [{ type: "web_search" }],
      },
      false,
      null,
      "gemini-web2api",
    );
    expect(translated.tools).toContainEqual({ googleSearch: {} });
    expect(translated.toolConfig?.includeServerSideToolInvocations).toBeUndefined();
  });
});
