// AIStudio bridge catalog + validation wiring: the provider registry ships no
// seeded models, so validation and both discovery routes must reach the
// bridge's own /v1/models endpoint with the connection API key.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const stub = vi.hoisted(() => ({
  fetchCalls: [],
  proxyCalls: [],
  proxyMode: "ok",
  connection: null,
  updated: [],
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options, proxyOptions) => {
    stub.proxyCalls.push({ url: String(url), options, proxyOptions });
    if (stub.proxyMode === "empty") return Response.json({ data: [] });
    if (stub.proxyMode === "unauthorized") return new Response("denied", { status: 401 });
    if (stub.proxyMode === "forbidden") return new Response("denied", { status: 403 });
    if (stub.proxyMode === "reject") throw new Error("bridge offline");
    return Response.json({ data: [{ id: "bridge-model-9" }, { id: "bridge-model-7", display_name: "Bridge Seven" }, { id: "" }] });
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
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => stub.proxyConfig || {},
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: async () => ({ ok: true }) }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  filterModelsListForKey: async (ctx, data) => data,
}));

const { PROVIDERS } = await import("open-sse/config/providers.js");
const { FORMATS } = await import("open-sse/translator/formats.js");
const { resolveAIStudioModels } = await import("open-sse/services/aistudioModels.js");
const validateRoute = await import("../../src/app/api/providers/validate/route.js");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const dashboardModels = await import("../../src/app/api/providers/[id]/models/route.js");
const v1Models = await import("../../src/app/api/v1/models/route.js");

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

describe("resolveAIStudioModels bridge catalog", () => {
  it("fetches the opaque bridge catalog with the connection Bearer key", async () => {
    const result = await resolveAIStudioModels(
      { apiKey: "bridge-key" }, { proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:3128" } });
    expect(stub.proxyCalls).toHaveLength(1);
    const call = stub.proxyCalls[0];
    expect(call.url).toBe(PROVIDERS.aistudio.validateUrl);
    expect(call.url.endsWith("/v1/models")).toBe(true);
    expect(call.options.headers.Authorization).toBe("Bearer bridge-key");
    expect(call.options.signal).toBeInstanceOf(AbortSignal);
    expect(call.proxyOptions).toEqual({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:3128" });
    expect(result.error).toBeUndefined();
    expect(result.models.map(m => m.id)).toEqual(["bridge-model-9", "bridge-model-7"]);
    expect(result.models[1].name).toBe("Bridge Seven");
  });

  it("returns the original status on 401/403 and [] on an empty 200 catalog", async () => {
    for (const [mode, status] of [["unauthorized", 401], ["forbidden", 403]]) {
      stub.proxyMode = mode;
      const result = await resolveAIStudioModels({ apiKey: "bridge-key" });
      expect(result).toMatchObject({ status });
      expect(result.error).toContain(String(status));
    }
    stub.proxyMode = "empty";
    expect(await resolveAIStudioModels({ apiKey: "bridge-key" })).toEqual({ models: [] });
  });

  it("does not fetch without an API key and the registry stays unseeded", async () => {
    const result = await resolveAIStudioModels({});
    expect(result).toMatchObject({ error: "No valid token found", status: 401 });
    expect(stub.proxyCalls).toHaveLength(0);
    expect((PROVIDERS.aistudio.models ?? []).length).toBe(0);
    expect(PROVIDERS.aistudio.format).toBe(FORMATS.GEMINI);
  });
});

describe("AIStudio credential validation", () => {
  const request = key => new Request("http://localhost/api/providers/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "aistudio", apiKey: key }),
  });

  it("validates a working bridge key through the exact models endpoint", async () => {
    const response = await validateRoute.POST(request("bridge-key"));
    const body = await response.json();
    expect(body.valid).toBe(true);
    expect(stub.fetchCalls).toHaveLength(1);
    const [url, options] = stub.fetchCalls[0];
    expect(String(url)).toBe(PROVIDERS.aistudio.validateUrl);
    expect(options.headers.Authorization).toBe("Bearer bridge-key");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(String(url)).not.toContain("generateContent");
  });

  it.each([401, 403])("reports %d bridge rejection as invalid", async status => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status }));
    const body = await (await validateRoute.POST(request("bad-key"))).json();
    expect(body.valid).toBe(false);
  });

  it("a rejected bridge request follows the existing invalid path", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("bridge offline"); });
    const body = await (await validateRoute.POST(request("bridge-key"))).json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("bridge offline");
  });

  it("testSingleConnection persists active for a working bridge and error for a rejected key", async () => {
    stub.connection = { id: "conn-1", provider: "aistudio", authType: "apikey",
      apiKey: "bridge-key", providerSpecificData: {} };
    const okResult = await testSingleConnection("conn-1");
    expect(okResult.valid).toBe(true);
    expect(okResult.error).toBeNull();
    expect(stub.updated.at(-1).data.testStatus).toBe("active");
    expect(stub.proxyCalls).toHaveLength(1);
    expect(stub.proxyCalls[0].url).toBe(PROVIDERS.aistudio.validateUrl);
    expect(stub.proxyCalls[0].options.headers.Authorization).toBe("Bearer bridge-key");
    expect(stub.proxyCalls[0].proxyOptions).toMatchObject(
      { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy:3128" });

    for (const mode of ["unauthorized", "forbidden"]) {
      stub.proxyMode = mode;
      stub.proxyCalls = [];
      const badResult = await testSingleConnection("conn-1");
      expect(badResult.valid).toBe(false);
      expect(badResult.error).toBe("Invalid API key");
      expect(badResult.error).not.toMatch(/not supported/i);
      expect(stub.updated.at(-1).data.testStatus).toBe("error");
      expect(stub.proxyCalls[0].url).toBe(PROVIDERS.aistudio.validateUrl);
    }
  });

  it("testSingleConnection uses the direct leg without an enabled proxy", async () => {
    stub.connection = { id: "conn-1", provider: "aistudio", authType: "apikey",
      apiKey: "bridge-key", providerSpecificData: {} };
    stub.proxyConfig = {};
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
    const result = await testSingleConnection("conn-1");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid API key");
    expect(stub.proxyCalls).toHaveLength(0);
    expect(stub.updated.at(-1).data.testStatus).toBe("error");
  });
});

describe("AIStudio catalog consumers", () => {
  const request = () => new Request("http://localhost/api/providers/conn-1/models");
  const params = { params: Promise.resolve({ id: "conn-1" }) };

  it("dashboard models route resolves the live bridge catalog once", async () => {
    stub.connection = { id: "conn-1", provider: "aistudio", authType: "apikey",
      apiKey: "bridge-key", providerSpecificData: {} };
    const response = await dashboardModels.GET(request(), params);
    const body = await response.json();
    expect(stub.proxyCalls).toHaveLength(1);
    expect(body.models.map(m => m.id)).toContain("bridge-model-9");
  });

  it.each([401, 403])("dashboard propagates bridge %d through the existing error path", async status => {
    stub.connection = { id: "conn-1", provider: "aistudio", authType: "apikey",
      apiKey: "bridge-key", providerSpecificData: {} };
    stub.proxyMode = status === 401 ? "unauthorized" : "forbidden";
    const response = await dashboardModels.GET(request(), params);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error).toContain(String(status));
  });

  it("/v1/models prefers the live catalog only without explicit enabled models", async () => {
    stub.connections = [{ id: "conn-1", provider: "aistudio", authType: "apikey",
      apiKey: "bridge-key", isActive: true, providerSpecificData: {} }];
    const live = await v1Models.buildModelsList(["llm"]);
    expect(stub.proxyCalls).toHaveLength(1);
    expect(live.some(row => row.id === "aistudio/bridge-model-9")).toBe(true);

    stub.proxyCalls = [];
    stub.connections = [{ id: "conn-1", provider: "aistudio", authType: "apikey",
      apiKey: "bridge-key", isActive: true,
      providerSpecificData: { enabledModels: ["aistudio/pinned-model"] } }];
    const explicit = await v1Models.buildModelsList(["llm"]);
    expect(stub.proxyCalls).toHaveLength(0);
    expect(explicit.some(row => row.id === "aistudio/pinned-model")).toBe(true);
  });

  it.each([
    ["inactive connection", [{ id: "conn-1", provider: "aistudio", authType: "apikey",
       apiKey: "bridge-key", isActive: false, providerSpecificData: {} }]],
    ["no aistudio connection", []],
  ])("/v1/models does not discover models for %s", async (_name, connections) => {
    stub.connections = connections;
    await v1Models.buildModelsList(["llm"]);
    expect(stub.proxyCalls).toHaveLength(0);
  });

  it("/v1/models keeps the existing fallback when the bridge fails", async () => {
    stub.connections = [{ id: "conn-1", provider: "aistudio", authType: "apikey",
      apiKey: "bridge-key", isActive: true, providerSpecificData: {} }];
    stub.customModels = [{ id: "kept-model", providerAlias: "aistudio" }];
    stub.proxyMode = "reject";
    const result = await v1Models.buildModelsList(["llm"]);
    expect(stub.proxyCalls).toHaveLength(1);
    expect(result.some(row => row.id === "aistudio/kept-model")).toBe(true);
    expect(result.some(row => row.id === "aistudio/bridge-model-9")).toBe(false);
  });
});
