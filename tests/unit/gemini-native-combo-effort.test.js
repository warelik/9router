// Regression: native Gemini combos with a trailing "(effort)" suffix, Cloud Code
// numeric thinkingLevel normalization, combo SSE peek for Gemini candidates, and
// per-key access for suffixed targets. Offline only: provider network, combos DB
// and credentials are mocked; real model resolution, key-access engine, combo
// handling, chat core (for Antigravity) and thinking normalization run for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const { network, executorInstances, fx } = vi.hoisted(() => ({
  network: vi.fn(),
  executorInstances: new Map(),
  fx: {
    combos: [
      { id: "ccarbon", name: ".gemini-carbon", models: ["ag/gemini-4-carbon-high"] },
      { id: "chydro", name: ".gemini-hydrogen", models: ["ag/gemini-4-hydrogen-xhigh"] },
      { id: "cflash", name: ".gemini-flash-lite", models: ["aistudio/gemini-3.5-flash-lite", "gemini/gemini-3.5-flash-lite"] },
      { id: "cmain", name: "Main", models: ["openai/model-a", "openai/model-b"] },
      { id: "cother", name: "other", models: ["openai/model-c"] },
    ],
    nodes: [],
    aliases: {},
    keys: {},
  },
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
vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => fx.aliases,
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async (filter = {}) => fx.nodes.filter((n) => !filter.type || n.type === filter.type),
  getSettings: async () => ({ requireApiKey: false }),
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/sse/utils/logger.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { getTargetFormat, supportsNativeGemini } = await import("../../open-sse/services/provider.js");
const { resolveSessionIdentity } = await import("../../open-sse/utils/sessionManager.js");
const modelSvc = await import("../../src/sse/services/model.js");
const keyAccessEngine = await import("../../src/sse/services/keyAccess.js");
const thinkingUnified = await import("../../open-sse/translator/concerns/thinkingUnified.js");
const emptyFailover = await import("../../open-sse/services/emptyFailover.js");
const comboSvc = await import("../../open-sse/services/combo.js");

const root = fileURLToPath(new URL("../../", import.meta.url));
const quiet = Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine"].map(name => [name, vi.fn()]));

function nativeBody(overrides = {}) {
  return {
    systemInstruction: { parts: [{ text: "Follow the task protocol." }] },
    contents: [
      { role: "user", parts: [{ text: "Use the tool result and continue." }] },
      { role: "model", parts: [
        { text: "Earlier reasoning.", thought: true },
        { functionCall: { id: "call-1", name: "lookup_record", args: { key: "x" } }, thoughtSignature: "sig-1" },
      ] },
      { role: "user", parts: [
        { functionResponse: { id: "call-1", name: "lookup_record", response: { value: 1 } } },
      ] },
    ],
    tools: [{ functionDeclarations: [{ name: "lookup_record", parameters: { type: "OBJECT", properties: { key: { type: "STRING" } } } }] }],
    generationConfig: { maxOutputTokens: 3072, thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    ...overrides,
  };
}

function nativeChunk(text = "completed") {
  return { candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] };
}
function sseFrame(value) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }
function wireRequest(index = -1) { return JSON.parse(network.mock.calls.at(index)[1].body); }

function moduleSource(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8")
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/^export /gm, "");
}

// Route harness modeled on antigravity-native-gemini.test.js, but with REAL
// model resolution over the mocked combos DB, REAL handleComboChat, and REAL
// handleChatCore (for antigravity members). aistudio/gemini members are served
// by a controllable stub that mimics native-Gemini chatCore output shape so the
// combo peek path (emptyFailover) is exercised against Gemini candidates SSE.
function loadRouteHarness({ flashImpl } = {}) {
  const flashCalls = [];
  const services = {
    handleChatCore: vi.fn(async (options) => {
      const provider = options.modelInfo?.provider;
      if (provider === "aistudio" || provider === "gemini") {
        flashCalls.push(options);
        if (options.credentials) options.credentials.nativeGeminiPassthrough = true;
        if (flashImpl) return flashImpl(options);
        return { success: true, response: new Response(sseFrame(nativeChunk(`from-${provider}`)), { headers: { "Content-Type": "text/event-stream" } }), nativeResponse: true };
      }
      return handleChatCore(options);
    }),
    getSettings: vi.fn(async () => ({ requireApiKey: false, comboStrategy: "fallback" })),
    getProviderCredentials: vi.fn(async () => ({ accessToken: "offline-token", apiKey: "offline-token", projectId: "fixture-project", connectionId: "route-fixture", providerSpecificData: {} })),
    getModelInfo: vi.fn((m) => modelSvc.getModelInfo(m)),
    isValidApiKey: vi.fn(async () => true),
    getKeyAccessContext: vi.fn(async () => null),
    enforceKeyAccess: vi.fn(async () => null),
    enforceKeyAccessResolved: vi.fn(async () => null),
    filterAdapterModels: vi.fn(async (_keyAccess, models) => models),
    markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
    clearAccountError: vi.fn(async () => {}),
    handleAntigravityQuotaError: vi.fn(async () => null),
    clearAntigravityStrikes: vi.fn(),
    getComboModels: vi.fn((m) => modelSvc.getComboModels(m)),
    handleComboChat: comboSvc.handleComboChat,
    handleFusionChat: comboSvc.handleFusionChat,
    detectRequiredCapabilities: comboSvc.detectRequiredCapabilities,
    augmentModelsWithCapacityAdapter: models => models,
    withCapacityAdapterStripping: callback => callback,
    getActiveAdapterStrategy: vi.fn(),
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
    Request, Response, Headers, URL, Buffer, AbortController, ReadableStream,
    TextEncoder, TextDecoder, TransformStream, setTimeout, clearTimeout,
    GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS: 50,
    PROVIDER_MODELS: { gemini: [], "gemini-tts-models": [] },
    HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, SERVER_ERROR: 500, SERVICE_UNAVAILABLE: 503 },
    ACCOUNT_WAIT_DEADLINE_MS: 0,
    FORMATS: { GEMINI: "gemini", OPENAI: "openai" },
    DEFAULT_HEADROOM_URL: "http://unused.test",
    getTargetFormat, supportsNativeGemini, resolveSessionIdentity,
    initTranslators: async () => {},
    proxyAwareFetch: (...args) => services.fetch(...args),
  };
  Object.assign(context, { createHash, isLocalRequest: () => false, hasValidCliToken: async () => false });
  vm.createContext(context);
  const auth = fs.readFileSync(path.join(root, "src/sse/services/auth.js"), "utf8");
  const start = auth.indexOf("export function extractApiKey(");
  const end = auth.indexOf("/**", start);
  vm.runInContext(auth.slice(start, end).replace("export ", ""), context);
  const ka = fs.readFileSync(path.join(root, "src/sse/services/keyAccess.js"), "utf8");
  const keyStart = ka.indexOf("export function extractClientApiKey(");
  const keyEnd = ka.indexOf("/**", keyStart);
  if (keyStart < 0 || keyEnd <= keyStart) throw new Error("Real client-key accessor is missing");
  vm.runInContext(ka.slice(keyStart, keyEnd).replace("export ", ""), context);
  vm.runInContext(moduleSource("src/sse/handlers/chat.js"), context);
  vm.runInContext(moduleSource("src/app/api/v1beta/models/[...path]/route.js"), context);
  return { context, services, flashCalls };
}

async function postCombo(context, comboWithAction, body) {
  const url = `https://router.test/v1beta/models/${comboWithAction}?alt=sse`;
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return context.POST(request, { params: Promise.resolve({ path: comboWithAction.split("/") }) });
}

describe("model resolution: combos with thinking suffix", () => {
  it("resolves suffixed combos to the stored combo name and members", async () => {
    expect(await modelSvc.getComboModels(".gemini-carbon(medium)")).toEqual(["ag/gemini-4-carbon-high"]);
    expect(await modelSvc.getComboModels(".gemini-hydrogen(xhigh)")).toEqual(["ag/gemini-4-hydrogen-xhigh"]);
    expect(await modelSvc.getComboModels(".gemini-flash-lite(8192)")).toEqual(["aistudio/gemini-3.5-flash-lite", "gemini/gemini-3.5-flash-lite"]);
    expect(await modelSvc.getModelInfo(".gemini-carbon(medium)")).toMatchObject({ provider: null, model: ".gemini-carbon" });
    expect((await modelSvc.getModelInfo(".gemini-carbon(medium)")).comboModels).toEqual(["ag/gemini-4-carbon-high"]);
    expect(await modelSvc.getComboModels(".gemini-carbon(preview)")).toBeNull();
  });

  it("keeps exact combo-name matching and ignores non-thinking parentheticals", async () => {
    expect(await modelSvc.getModelInfo("Main(medium)")).toMatchObject({ provider: null, model: "Main" });
    expect(await modelSvc.getComboModels("Main(medium)")).toEqual(["openai/model-a", "openai/model-b"]);
    // Case variant must NOT route to the combo (exact lookup), mirroring key-access bypass checks.
    expect(await modelSvc.getComboModels("MAIN(medium)")).toBeNull();
    const mainUpper = await modelSvc.getModelInfo("MAIN(medium)");
    expect(mainUpper.provider).not.toBeNull();
    expect(await modelSvc.getComboModels("Preview(beta)")).toBeNull();
  });

  it("extractThinkingSuffix only strips recognized thinking values", () => {
    expect(thinkingUnified.extractThinkingSuffix(".gemini-carbon(medium)")).toEqual({ cleanModel: ".gemini-carbon", suffix: "medium" });
    expect(thinkingUnified.extractThinkingSuffix(".gemini-flash-lite(8192)")).toEqual({ cleanModel: ".gemini-flash-lite", suffix: "8192" });
    expect(thinkingUnified.extractThinkingSuffix("Preview(beta)")).toEqual({ cleanModel: "Preview(beta)", suffix: null });
    expect(thinkingUnified.withThinkingSuffix("ag/gemini-4-carbon-high(high)", "medium")).toBe("ag/gemini-4-carbon-high(medium)");
    expect(thinkingUnified.withThinkingSuffix("ag/gemini-4-carbon-high", "medium")).toBe("ag/gemini-4-carbon-high(medium)");
  });
});

describe("key access: suffixed combos and models", () => {
  function key(id, access) { fx.keys[`sk-${id}`] = { id, name: `key-${id}`, isActive: true, access }; }
  const req = (k) => new Request("http://localhost/v1/chat/completions", { method: "POST", headers: k ? { Authorization: `Bearer ${k}` } : {} });
  const ctxFor = (k) => keyAccessEngine.getKeyAccessContext(req(k));
  async function status(k, model) {
    const r = await keyAccessEngine.enforceKeyAccess(await ctxFor(k), model);
    return r ? r.status : 200;
  }
  beforeEach(() => {
    fx.keys = {};
    key("combo", { restricted: true, allow: ["main"] });
    key("cx", { restricted: true, allow: ["cx/gpt-5"] });
  });

  it("allows a listed combo with an effort suffix and denies lookalikes", async () => {
    expect(await status("sk-combo", "Main(medium)")).toBe(200);
    expect(await status("sk-combo", "MAIN(medium)")).toBe(403);
    expect(await status("sk-combo", "other(medium)")).toBe(403);
    expect(await status("sk-combo", "Main")).toBe(200);
    expect(await status("sk-combo", "MAIN")).toBe(403);
  });

  it("allows a listed model with an effort suffix and denies other models", async () => {
    expect(await status("sk-cx", "cx/gpt-5(high)")).toBe(200);
    expect(await status("sk-cx", "cx/gpt-5")).toBe(200);
    expect(await status("sk-cx", "cx/gpt-5-mini(high)")).toBe(403);
  });
});

describe("thinking normalization: Cloud Code numeric thinkingLevel", () => {
  it("extractThinking reads integer 1..6 and EXTRA_HIGH", () => {
    expect(thinkingUnified.extractThinking({ generationConfig: { thinkingConfig: { thinkingLevel: 5, includeThoughts: true } } }))
      .toEqual({ mode: "level", level: "xhigh" });
    expect(thinkingUnified.extractThinking({ generationConfig: { thinkingConfig: { thinkingLevel: "EXTRA_HIGH" } } }))
      .toEqual({ mode: "level", level: "xhigh" });
    expect(thinkingUnified.extractThinking({ generation_config: { thinking_config: { thinking_level: 2 } } }))
      .toEqual({ mode: "level", level: "medium" });
    expect(thinkingUnified.extractThinking({ generationConfig: { thinkingConfig: { thinkingLevel: 0 } } })).toBeNull();
  });

  it("applyNativeGeminiThinking normalizes numeric 5 to HIGH for gemini-4 and never leaks the number", () => {
    const out = thinkingUnified.applyNativeGeminiThinking(
      "gemini-4-hydrogen-xhigh",
      { generationConfig: { thinkingConfig: { thinkingLevel: 5, includeThoughts: true } } },
      "antigravity", null);
    expect(out.generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
    // Suffix override on the member wins over the client numeric level.
    const overridden = thinkingUnified.applyNativeGeminiThinking(
      "gemini-4-carbon-high(medium)",
      { generationConfig: { thinkingConfig: { thinkingLevel: 5, includeThoughts: true } } },
      "antigravity", null);
    expect(overridden.generationConfig.thinkingConfig.thinkingLevel).toBe("MEDIUM");
    // Standard explicit client fields without normalization needs stay untouched.
    const untouched = { generationConfig: { thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } } };
    expect(thinkingUnified.applyNativeGeminiThinking("gemini-4-carbon-low", untouched, "antigravity", null)).toBe(untouched);
  });

  it("empty peek understands Gemini candidates SSE and thought-only abort frames", () => {
    const okLine = `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}`;
    expect(emptyFailover.inspectSSELine(okLine)).toEqual({ content: true, finishReason: "stop" });
    const abortLine = `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"thinking","thought":true}]},"finishReason":"MALFORMED_FUNCTION_CALL"}]}`;
    expect(emptyFailover.inspectSSELine(abortLine).content).toBe(false);
    expect(emptyFailover.isNoRetryFinish(emptyFailover.inspectSSELine(abortLine).finishReason)).toBe(false);
    expect(comboSvc.isZeroContentResponse({ candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] })).toBe(true);
    expect(comboSvc.isZeroContentResponse(nativeChunk("ok"))).toBe(false);
  });
});

describe("native Gemini combo routing end-to-end", () => {
  beforeEach(() => {
    network.mockReset();
    executorInstances.clear();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("DIRECT_NETWORK_FORBIDDEN"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it(".gemini-carbon(medium) streams through native Antigravity passthrough with MEDIUM effort", async () => {
    network.mockImplementation(async () => new Response(
      sseFrame({ response: nativeChunk("carbon-ok") }),
      { headers: { "Content-Type": "text/event-stream" } }));
    const { context, services } = loadRouteHarness();
    const response = await postCombo(context, ".gemini-carbon(medium):streamGenerateContent", nativeBody());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("carbon-ok");
    expect(network).toHaveBeenCalledOnce();
    const wire = wireRequest();
    expect(wire.model).toBe("gemini-4-carbon-high");
    expect(wire.request.generationConfig.thinkingConfig.thinkingLevel).toBe("MEDIUM");
    // Native passthrough preserves tools / calls / signatures byte-meaningfully.
    expect(wire.request.tools[0].functionDeclarations.map((fn) => fn.name)).toContain("lookup_record");
    expect(wire.request.contents[1].parts).toContainEqual({
      functionCall: { id: "call-1", name: "lookup_record", args: { key: "x" } }, thoughtSignature: "sig-1",
    });
    expect(wire.request.contents[2].parts).toContainEqual({
      functionResponse: { id: "call-1", name: "lookup_record", response: { value: 1 } },
    });
    expect(services.handleChatCore.mock.calls[0][0].credentials.nativeGeminiPassthrough).toBe(true);
    expect(services.handleChatCore.mock.calls[0][0].sourceFormatOverride).toBe("gemini");
  });

  it(".gemini-hydrogen(xhigh) with numeric thinkingLevel 5 maps to HIGH", async () => {
    network.mockImplementation(async () => new Response(
      sseFrame({ response: nativeChunk("hydrogen-ok") }),
      { headers: { "Content-Type": "text/event-stream" } }));
    const { context } = loadRouteHarness();
    const body = nativeBody({ generationConfig: { maxOutputTokens: 3072, thinkingConfig: { thinkingLevel: 5, includeThoughts: true } } });
    const response = await postCombo(context, ".gemini-hydrogen(xhigh):streamGenerateContent", body);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hydrogen-ok");
    const wire = wireRequest();
    expect(wire.model).toBe("gemini-4-hydrogen-xhigh");
    expect(wire.request.generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
  });

  it(".gemini-flash-lite(high) does not call the second member after a content frame", async () => {
    const { context, flashCalls } = loadRouteHarness();
    const response = await postCombo(context, ".gemini-flash-lite(high):streamGenerateContent", nativeBody());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("from-aistudio");
    expect(flashCalls.map((c) => c.modelInfo.provider)).toEqual(["aistudio"]);
    // Outer "(high)" reached the member as its thinking suffix.
    expect(flashCalls[0].body.model).toBe("aistudio/gemini-3.5-flash-lite(high)");
  });

  it(".gemini-flash-lite(high) fails over after a thought-only MALFORMED_FUNCTION_CALL stream", async () => {
    let attempt = 0;
    const abortChunk = { candidates: [{ content: { role: "model", parts: [{ text: "thinking", thought: true }] }, finishReason: "MALFORMED_FUNCTION_CALL" }] };
    const { context, flashCalls } = loadRouteHarness({
      flashImpl: async (options) => {
        attempt += 1;
        if (attempt === 1) {
          return { success: true, nativeResponse: true, response: new Response(sseFrame(abortChunk), { headers: { "Content-Type": "text/event-stream" } }) };
        }
        return { success: true, nativeResponse: true, response: new Response(sseFrame(nativeChunk("second-member-ok")), { headers: { "Content-Type": "text/event-stream" } }) };
      },
    });
    const response = await postCombo(context, ".gemini-flash-lite(high):streamGenerateContent", nativeBody());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("second-member-ok");
    expect(flashCalls.map((c) => c.modelInfo.provider)).toEqual(["aistudio", "gemini"]);
  });

  it("all members failing yields a Gemini error envelope", async () => {
    const { context, services } = loadRouteHarness({
      flashImpl: async () => ({
        success: false, status: 503, error: "No active credentials for provider: aistudio",
        response: Response.json({ error: { message: "No active credentials for provider: aistudio" } }, { status: 503 }),
      }),
    });
    const response = await postCombo(context, ".gemini-flash-lite(high):streamGenerateContent", nativeBody());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe(503);
    expect(body.error.status).toBe("UNAVAILABLE");
    expect(body.error.message).toContain("No active credentials");
    expect(services.handleChatCore).toHaveBeenCalled();
  });
});
