// Native Gemini disabled-function structured-output controls through the
// public route, real chat core, and real Antigravity executor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const { network, executorInstances } = vi.hoisted(() => ({
  network: vi.fn(),
  executorInstances: new Map(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: network }));
vi.mock("../../open-sse/executors/index.js", async () => {
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
  return {
    getExecutor(provider) {
      if (provider !== "antigravity") throw new Error(`Unexpected fixture provider: ${provider}`);
      if (!executorInstances.has(provider)) executorInstances.set(provider, new AntigravityExecutor());
      return executorInstances.get(provider);
    },
  };
});
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => new Proxy({}, {
    get: (_target, name) => name === "then" ? undefined : vi.fn(),
  }),
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

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getTargetFormat, supportsNativeGemini } = await import("../../open-sse/services/provider.js");
const { ANTIGRAVITY_HEADERS } = await import("../../open-sse/config/appConstants.js");

const root = fileURLToPath(new URL("../../", import.meta.url));
const MODEL = "gemini-3.8-flash-high";
const quiet = Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine"].map(name => [name, vi.fn()]));
const SCHEMA = {
  type: "OBJECT",
  properties: { code: { type: "STRING" } },
  required: ["code"],
  additionalProperties: false,
  description: "Preserve this complete response schema.",
};

function makeBody({ schemaKey = "responseSchema", mode = "NONE" } = {}) {
  return {
    systemInstruction: { parts: [{ text: "Follow the task protocol." }] },
    contents: [
      { role: "user", parts: [{ text: "Read the image and return its code as JSON." }] },
      { role: "model", parts: [
        { text: "Earlier thought", thought: true, thoughtSignature: "history-thought-signature" },
        { functionCall: { id: "history-call-31", name: "lookup_record", args: { key: "opaque" } }, thoughtSignature: "history-call-signature" },
      ] },
      { role: "user", parts: [
        { functionResponse: { id: "history-call-31", name: "lookup_record", response: { record: { value: 31 } } } },
        { inlineData: { mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" } },
        { futurePart: { preserve: true, token: "opaque-client-part" } },
      ] },
    ],
    tools: [
      {
        functionDeclarations: [{
          name: "forbidden_dummy",
          description: "Must remain disabled in this control.",
          parametersJsonSchema: { type: "OBJECT", properties: { code: { type: "STRING" } } },
        }],
        googleSearch: { dynamicRetrievalConfig: { mode: "MODE_UNSPECIFIED" } },
        futureGroupField: { group: "search-and-functions", value: 1 },
      },
      {
        function_declarations: [{ name: "inactive_snake_alias", parameters: { type: "OBJECT" } }],
        urlContext: {},
        futureGroupField: { group: "url-and-functions", value: 2 },
      },
      {
        functionDeclarations: [{ name: "only_inactive_function", parameters: { type: "OBJECT" } }],
      },
    ],
    toolConfig: { functionCallingConfig: { mode, allowedFunctionNames: ["forbidden_dummy"] } },
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0,
      thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
      responseMimeType: "application/json",
      [schemaKey]: structuredClone(SCHEMA),
    },
    cachedContent: "cachedContents/native-prefix",
    clientExtension: { continuation: { token: "opaque-future-field" } },
  };
}

function responseForWire(wire) {
  const declarationsRemain = (wire.request.tools || []).some(group =>
    (group.functionDeclarations || []).length > 0 || (group.function_declarations || []).length > 0
  );
  const candidate = declarationsRemain
    ? {
        index: 0,
        content: { role: "model", parts: [{
          functionCall: { id: "provider-forbidden-call", name: "forbidden_dummy", args: { code: "4821" } },
          thoughtSignature: "provider-function-signature",
        }] },
        finishReason: "STOP",
      }
    : {
        index: 0,
        content: { role: "model", parts: [{ text: "{\"code\":\"4821\"}" }] },
        finishReason: "STOP",
      };
  return Response.json({ response: {
    candidates: [candidate],
    usageMetadata: { promptTokenCount: 81, candidatesTokenCount: 4, totalTokenCount: 85 },
  } });
}

function moduleSource(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8")
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/^export /gm, "");
}

function loadPublicNativeRoute() {
  const services = {
    handleChatCore: vi.fn(options => handleChatCore(options)),
    getSettings: vi.fn(async () => ({ requireApiKey: false })),
    getProviderCredentials: vi.fn(async () => ({ accessToken: "offline-token", projectId: "fixture-project", connectionId: "route-fixture", providerSpecificData: {} })),
    getModelInfo: vi.fn(async model => {
      const index = model.indexOf("/");
      return index < 0 ? { provider: null, model } : { provider: model.slice(0, index), model: model.slice(index + 1) };
    }),
    isValidApiKey: vi.fn(async () => true),
    getKeyAccessContext: vi.fn(async () => null),
    enforceKeyAccess: vi.fn(async () => null),
    enforceKeyAccessResolved: vi.fn(async () => null),
    filterAdapterModels: vi.fn(async (_keyAccess, models) => models),
    markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
    clearAccountError: vi.fn(async () => {}),
    handleAntigravityQuotaError: vi.fn(async () => null),
    clearAntigravityStrikes: vi.fn(),
    getComboModels: vi.fn(async () => null),
    augmentModelsWithCapacityAdapter: models => models,
    withCapacityAdapterStripping: callback => callback,
    getActiveAdapterStrategy: vi.fn(),
    detectRequiredCapabilities: () => new Set(),
    handleBypassRequest: () => null,
    checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
    updateProviderCredentials: vi.fn(async () => {}),
    getProjectIdForConnection: vi.fn(async () => "fixture-project"),
    getPxpipeTransform: vi.fn(async () => null),
    appendPxpipeEvent: vi.fn(),
    detectFormatByEndpoint: vi.fn(() => null),
    stripModelContextMarker: model => ({ model, contextMarker: null }),
    upstreamResponseHeaders: headers => Object.fromEntries(headers || []),
    errorResponse: (status, message, headers) => Response.json({ error: { message } }, { status, headers }),
    unavailableResponse: (status, message) => Response.json({ error: { message } }, { status }),
    fetch: vi.fn(),
  };
  const logger = Object.fromEntries(["log", "debug", "info", "warn", "error"].map(name => [name, vi.fn()]));
  logger.maskKey = () => "masked-fixture-key";
  const context = {
    ...services,
    console: logger,
    log: logger,
    Request,
    Response,
    Headers,
    URL,
    Buffer,
    AbortController,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    TransformStream,
    setTimeout,
    clearTimeout,
    GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS: 50,
    PROVIDER_MODELS: { gemini: [], "gemini-tts-models": [] },
    HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, SERVICE_UNAVAILABLE: 503 },
    FORMATS: { GEMINI: "gemini", OPENAI: "openai" },
    DEFAULT_HEADROOM_URL: "http://unused.test",
    getTargetFormat,
    supportsNativeGemini,
    initTranslators: async () => {},
    proxyAwareFetch: (...args) => services.fetch(...args),
    stripModelContextMarker: services.stripModelContextMarker,
    detectRequiredCapabilities: services.detectRequiredCapabilities,
    augmentModelsWithCapacityAdapter: services.augmentModelsWithCapacityAdapter,
    handleBypassRequest: services.handleBypassRequest,
    checkAndRefreshToken: services.checkAndRefreshToken,
    getPxpipeTransform: services.getPxpipeTransform,
    appendPxpipeEvent: services.appendPxpipeEvent,
    detectFormatByEndpoint: services.detectFormatByEndpoint,
    upstreamResponseHeaders: services.upstreamResponseHeaders,
    updateProviderCredentials: services.updateProviderCredentials,
    unavailableResponse: services.unavailableResponse,
  };
  vm.createContext(context);

  const auth = fs.readFileSync(path.join(root, "src/sse/services/auth.js"), "utf8");
  const start = auth.indexOf("export function extractApiKey(");
  const end = auth.indexOf("/**", start);
  vm.runInContext(auth.slice(start, end).replace("export ", ""), context);
  // Upstream added the wider client-key accessor; load its real pure implementation
  // just like the legacy auth accessor, without importing DB/account boundaries.
  const keyAccess = fs.readFileSync(path.join(root, "src/sse/services/keyAccess.js"), "utf8");
  const keyStart = keyAccess.indexOf("export function extractClientApiKey(");
  const keyEnd = keyAccess.indexOf("/**", keyStart);
  if (keyStart < 0 || keyEnd <= keyStart) throw new Error("Real client-key accessor is missing");
  vm.runInContext(keyAccess.slice(keyStart, keyEnd).replace("export ", ""), context);
  vm.runInContext(moduleSource("src/sse/handlers/chat.js"), context);
  vm.runInContext(moduleSource("src/app/api/v1beta/models/[...path]/route.js"), context);
  return { context, services };
}

async function postNative(body) {
  const { context, services } = loadPublicNativeRoute();
  const modelPath = `antigravity/${MODEL}:generateContent`;
  const request = new Request(`https://router.test/v1beta/models/${modelPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer router-client-key" },
    body: JSON.stringify(body),
  });
  const response = await context.POST(request, {
    params: Promise.resolve({ path: ["antigravity", `${MODEL}:generateContent`] }),
  });
  return { response, services };
}

function wireRequest(index = -1) {
  return JSON.parse(network.mock.calls.at(index)[1].body);
}

function expectedBuiltinTools() {
  return [
    {
      googleSearch: { dynamicRetrievalConfig: { mode: "MODE_UNSPECIFIED" } },
      futureGroupField: { group: "search-and-functions", value: 1 },
    },
    {
      urlContext: {},
      futureGroupField: { group: "url-and-functions", value: 2 },
    },
  ];
}

describe("native Gemini disabled function declarations with JSON response schema", () => {
  beforeEach(() => {
    network.mockReset();
    executorInstances.clear();
    network.mockImplementation(async (_url, options) => responseForWire(JSON.parse(options.body)));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("DIRECT_NETWORK_FORBIDDEN"); }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["responseSchema", "camelCase"],
    ["response_schema", "snake_case"],
  ])("removes only inactive function declarations for NONE with %s", async (schemaKey, _caseName) => {
    const body = makeBody({ schemaKey, mode: "NONE" });
    const before = structuredClone(body);
    const { response, services } = await postNative(body);

    expect(response.status).toBe(200);
    const returned = await response.json();
    const ordinaryText = returned.candidates[0].content.parts.find(part => typeof part.text === "string")?.text;
    expect(JSON.parse(ordinaryText)).toEqual({ code: "4821" });
    expect(returned.candidates[0].finishReason).toBe("STOP");
    expect(returned.candidates[0].content.parts.some(part => part.functionCall)).toBe(false);
    expect(services.handleChatCore).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledOnce();

    const wire = wireRequest();
    expect(wire).toMatchObject({
      project: "fixture-project",
      model: MODEL,
      userAgent: "antigravity",
      request: {
        systemInstruction: before.systemInstruction,
        contents: before.contents,
        cachedContent: before.cachedContent,
        clientExtension: before.clientExtension,
        toolConfig: before.toolConfig,
      },
    });
    expect(wire).not.toHaveProperty("requestType");
    expect(wire.requestId).toMatch(/^agent\/.+\/\d+\/.+\/\d+$/);
    expect(wire.request.generationConfig[schemaKey]).toEqual(SCHEMA);
    expect(wire.request.generationConfig.responseMimeType).toBe("application/json");
    expect(wire.request.generationConfig.maxOutputTokens).toBe(2048);
    expect(wire.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "HIGH", includeThoughts: true });
    expect(wire.request.toolConfig.functionCallingConfig).toEqual({ mode: "NONE", allowedFunctionNames: ["forbidden_dummy"] });
    expect(wire.request.tools).toEqual(expectedBuiltinTools());
    expect(wire.request.tools.flatMap(group => Object.keys(group))).toEqual([
      "googleSearch", "futureGroupField", "urlContext", "futureGroupField",
    ]);
    expect(body).toEqual(before);

    const headers = new Headers(network.mock.calls[0][1].headers);
    expect(headers.get("authorization")).toBe("Bearer offline-token");
    expect(headers.get("user-agent")).toBe(ANTIGRAVITY_HEADERS["User-Agent"]);
  });

  it("keeps declarations when only responseJsonSchema is present with NONE", async () => {
    const body = makeBody({ schemaKey: "responseJsonSchema", mode: "NONE" });
    const beforeTools = structuredClone(body.tools);
    const { response } = await postNative(body);

    expect(response.status).toBe(200);
    const returned = await response.json();
    expect(returned.candidates[0].content.parts[0].functionCall).toMatchObject({
      id: "provider-forbidden-call",
      name: "forbidden_dummy",
    });
    const wire = wireRequest();
    expect(wire.request.generationConfig.responseJsonSchema).toEqual(SCHEMA);
    expect(wire.request.generationConfig.responseSchema).toBeUndefined();
    expect(wire.request.tools).toEqual(beforeTools);
  });

  it("preserves opaque nested request data without treating it as parent generation controls", async () => {
    const body = makeBody({ schemaKey: "responseSchema", mode: "AUTO" });
    delete body.generationConfig.responseSchema;
    delete body.generationConfig.responseMimeType;
    body.request = {
      generationConfig: { responseSchema: SCHEMA, responseMimeType: "application/json" },
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
      tools: [{ functionDeclarations: [{ name: "initialize_child_task", parameters: SCHEMA }] }],
      initialMessage: { task: "opaque child initialization", context: "retain this packet" },
    };
    const before = structuredClone(body);
    const text = '```json\n{"code":"4821"}\n```';
    network.mockImplementationOnce(async () => Response.json({ response: {
      candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    } }));
    const { response } = await postNative(body);
    const returned = await response.json();
    expect(returned.candidates[0].content.parts[0].text).toBe(text);
    expect(wireRequest().request.request).toEqual(before.request);
    expect(wireRequest().request.tools).toEqual(before.tools);
    expect(body).toEqual(before);
  });

  it.each(["AUTO", "ANY", "VALIDATED", undefined])("keeps declarations for responseSchema with tool mode %s", async mode => {
    const body = makeBody({ schemaKey: "responseSchema", mode });
    const beforeTools = structuredClone(body.tools);
    if (mode === undefined) delete body.toolConfig.functionCallingConfig.mode;
    const { response } = await postNative(body);

    expect(response.status).toBe(200);
    const returned = await response.json();
    expect(returned.candidates[0].content.parts[0].functionCall).toMatchObject({
      id: "provider-forbidden-call",
      name: "forbidden_dummy",
    });
    const wire = wireRequest();
    expect(wire.request.generationConfig.responseSchema).toEqual(SCHEMA);
    expect(wire.request.tools).toEqual(beforeTools);
    expect(wire.request.toolConfig.functionCallingConfig.mode).toBe(mode);
  });
});
