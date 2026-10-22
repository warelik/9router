// Native Gemini → Antigravity regression coverage. The provider network and
// accounting boundaries are replaced; the real chat core and Antigravity
// executor own request/response adaptation.
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
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { getTargetFormat, supportsNativeGemini } = await import("../../open-sse/services/provider.js");
const { ANTIGRAVITY_HEADERS } = await import("../../open-sse/config/appConstants.js");
const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");

const root = fileURLToPath(new URL("../../", import.meta.url));
const MODEL = "gemini-3.8-flash-high";
const quiet = Object.fromEntries(["debug", "info", "warn", "error", "line", "errorLine"].map(name => [name, vi.fn()]));

function nativeBody() {
  return {
    systemInstruction: { parts: [{ text: "Follow the task protocol." }] },
    contents: [
      { role: "user", parts: [{ text: "Use the tool result and continue." }] },
      { role: "model", parts: [
        { text: "Earlier reasoning that remains available.", thought: true },
        { functionCall: { id: "call-native-17", name: "lookup_record", args: { key: "opaque-9" } }, thoughtSignature: "native-call-signature" },
      ] },
      { role: "user", parts: [
        { functionResponse: { id: "call-native-17", name: "lookup_record", response: { record: { kind: "customer", value: 17 } } } },
        { inlineData: { mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" } },
      ] },
    ],
    tools: [
      { functionDeclarations: [{ name: "lookup_record", parameters: { type: "OBJECT", properties: { key: { type: "STRING" } }, required: ["key"] } }] },
      { functionDeclarations: [{ name: "finish_task", parameters: { type: "OBJECT", properties: { result: { type: "STRING" } } } }] },
    ],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup_record", "finish_task"] } },
    generationConfig: {
      maxOutputTokens: 3072,
      temperature: 0,
      thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    },
    cachedContent: "cachedContents/native-prefix",
    clientExtension: { continuation: { kind: "delegated-task", token: "fixture-state" } },
  };
}

function makeCredentials() {
  return {
    accessToken: "offline-provider-token",
    projectId: "fixture-project",
    connectionId: "offline-antigravity-test",
    providerSpecificData: {},
  };
}

async function runNativeGemini(requestBody = nativeBody(), {
  stream = false,
  signal,
  onRequestSuccess,
  model = MODEL,
  queryParams = [],
  headers = {},
} = {}) {
  const rawBody = structuredClone(requestBody);
  const credentials = makeCredentials();
  const result = await handleChatCore({
    body: { ...structuredClone(requestBody), model: `antigravity/${model}`, stream },
    modelInfo: { provider: "antigravity", model },
    sourceFormatOverride: FORMATS.GEMINI,
    credentials,
    clientRawRequest: {
      endpoint: `/v1beta/models/antigravity/${model}:${stream ? "streamGenerateContent" : "generateContent"}`,
      body: rawBody,
      headers: { "user-agent": "native-gemini-fixture", ...headers },
      queryParams,
      apiVersion: "v1beta",
    },
    connectionId: credentials.connectionId,
    userAgent: "native-gemini-fixture",
    clientSignal: signal,
    onRequestSuccess,
    log: quiet,
    providerThinking: { mode: "high" },
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
  });
  return { result, credentials, rawBody };
}

function wireRequest() {
  return JSON.parse(network.mock.calls.at(-1)[1].body);
}

function nativeChunk(text = "completed") {
  return {
    candidates: [{
      index: 0,
      content: { role: "model", parts: [{ text }] },
      finishReason: "STOP",
    }],
  };
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function byteFragmentedStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
}

function moduleSource(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8")
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace(/^export /gm, "");
}

function loadRouteHarness() {
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
  vm.runInContext(moduleSource("src/sse/handlers/chat.js"), context);
  vm.runInContext(moduleSource("src/app/api/v1beta/models/[...path]/route.js"), context);
  return { context, services };
}

async function postNativeGemini(context, requestBody = nativeBody()) {
  const request = new Request(`https://router.test/v1beta/models/antigravity/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  return context.POST(request, {
    params: Promise.resolve({ path: ["antigravity", `${MODEL}:generateContent`] }),
  });
}

describe("native Gemini through Antigravity", () => {
  beforeEach(() => {
    network.mockReset();
    executorInstances.clear();
    network.mockImplementation(async () => Response.json({ response: nativeChunk() }));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("DIRECT_NETWORK_FORBIDDEN"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("wraps the native body for Antigravity while preserving continuation, controls and media meaning", async () => {
    const original = nativeBody();
    const before = structuredClone(original);
    network.mockImplementationOnce(async () => Response.json({ response: nativeChunk("done") }));

    const { result, credentials } = await runNativeGemini(original);
    expect(result.success).toBe(true);
    expect(credentials.nativeGeminiPassthrough).toBe(true);
    expect(original).toEqual(before);

    const wire = wireRequest();
    expect(wire).toMatchObject({
      project: "fixture-project",
      model: MODEL,
      userAgent: "antigravity",
      request: {
        systemInstruction: original.systemInstruction,
        cachedContent: original.cachedContent,
        clientExtension: original.clientExtension,
        generationConfig: {
          maxOutputTokens: 3072,
          thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
          mediaResolution: "MEDIA_RESOLUTION_HIGH",
        },
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup_record", "finish_task"] } },
      },
    });
    expect(wire.request.contents.map(item => item.role)).toEqual(["user", "model", "user"]);
    expect(wire.request.contents[1].parts).toContainEqual({ text: "Earlier reasoning that remains available.", thought: true });
    expect(wire.request.contents[1].parts).toContainEqual({
      functionCall: { id: "call-native-17", name: "lookup_record", args: { key: "opaque-9" } },
      thoughtSignature: "native-call-signature",
    });
    expect(wire.request.contents[2].parts).toContainEqual({
      functionResponse: { id: "call-native-17", name: "lookup_record", response: { record: { kind: "customer", value: 17 } } },
    });
    expect(wire.request.contents[2].parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" } });
    expect(wire.request.tools).toHaveLength(2);
    expect(wire.request.tools).toEqual(original.tools);
    expect(wire).not.toHaveProperty("requestType");
    expect(wire.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/);
    const headers = new Headers(network.mock.calls[0][1].headers);
    expect(headers.get("authorization")).toBe("Bearer offline-provider-token");
    expect(headers.get("user-agent")).toBe(ANTIGRAVITY_HEADERS["User-Agent"]);
    expect(wire.request.tools.flatMap(group => group.functionDeclarations.map(fn => fn.name)).sort()).toEqual(["finish_task", "lookup_record"]);
    expect(await result.response.json()).toEqual(nativeChunk("done"));
  });

  it("unwraps byte-fragmented Antigravity SSE and keeps late usage after a finished tool call", async () => {
    const call = {
      candidates: [{ index: 0, content: { role: "model", parts: [
        { functionCall: { id: "call-stream-23", name: "lookup_record", args: { key: "новое-значение" } }, thoughtSignature: "stream-signature" },
      ] }, finishReason: "STOP" }],
    };
    const lateUsage = { usageMetadata: { promptTokenCount: 81, candidatesTokenCount: 12, cachedContentTokenCount: 64, totalTokenCount: 93 } };
    const upstream = sseFrame({ response: call, serverTrace: "opaque" }) + sseFrame({ response: lateUsage });
    network.mockImplementationOnce(async () => new Response(byteFragmentedStream(upstream), {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const { result } = await runNativeGemini(nativeBody(), { stream: true, queryParams: [["alt", "sse"]] });
    expect(result.success).toBe(true);
    const output = await result.response.text();
    const frames = output.split(/\r?\n\r?\n/)
      .filter(frame => frame.startsWith("data:"))
      .map(frame => JSON.parse(frame.replace(/^data:\s*/, "")));
    expect(frames).toEqual([{ ...call, serverTrace: "opaque" }, lateUsage]);
    expect(frames[0].candidates[0].content.parts[0].functionCall).toEqual({
      id: "call-stream-23", name: "lookup_record", args: { key: "новое-значение" },
    });
  });

  it("adapts upstream SSE to the native JSON-array stream requested without alt=sse", async () => {
    const first = nativeChunk("модель готова");
    const usage = { usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 4096, totalTokenCount: 5000 } };
    network.mockImplementationOnce(async () => new Response(byteFragmentedStream(sseFrame({ response: first }) + sseFrame({ response: usage })), {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const { result } = await runNativeGemini(nativeBody(), { stream: true });
    expect(result.response.headers.get("content-type")).toBe("application/json");
    expect(await result.response.json()).toEqual([first, usage]);
  });

  it("retains native JSON Schema and disabled tool mode without touching ordinary argument keys", async () => {
    const original = nativeBody();
    original.tools = [{ functionDeclarations: [{ name: "lookup_record", parametersJsonSchema: {
      type: "object", properties: { default: { type: "string", const: "required-value" } }, required: ["default"], additionalProperties: false,
    } }] }];
    original.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    original.contents[1].parts[1].functionCall.args = { default: "required-value", format: "user-data", title: "user-data" };
    const { result } = await runNativeGemini(original);
    expect(wireRequest().request.tools).toEqual(original.tools);
    expect(wireRequest().request.toolConfig).toEqual(original.toolConfig);
    expect(wireRequest().request.contents).toEqual(original.contents);
    await result.response.text();
  });

  it.each([
    ["nested query", [["fields", "candidates(content(parts(text))),usageMetadata(cachedContentTokenCount)"]], {}],
    ["slash query", [["$fields", "candidates/content/parts/text,usageMetadata/cachedContentTokenCount"]], {}],
    ["header", [], { "X-Goog-FieldMask": "candidates.content.parts.text,usageMetadata.cachedContentTokenCount" }],
  ])("applies the client's %s projection to unary and both stream framings", async (_name, queryParams, headers) => {
    const reply = { ...nativeChunk("selected"), usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 4096 } };
    const selected = { candidates: [{ content: { parts: [{ text: "selected" }] } }], usageMetadata: { cachedContentTokenCount: 4096 } };
    for (const framing of ["unary", "sse", "json"]) {
      network.mockImplementationOnce(async () => framing === "unary" ? Response.json({ response: reply })
        : new Response(sseFrame({ response: reply }), { headers: { "Content-Type": "text/event-stream" } }));
      const { result } = await runNativeGemini(nativeBody(), {
        stream: framing !== "unary", queryParams: [...queryParams, ["alt", framing === "sse" ? "sse" : "json"]], headers,
      });
      expect(result.success).toBe(true);
      if (framing === "sse") {
        const text = await result.response.text();
        expect(JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6))).toEqual(selected);
      } else expect(await result.response.json()).toEqual(framing === "unary" ? selected : [selected]);
    }
  });

  it("a whole parent selector wins over a narrower selector for the same parent", async () => {
    const reply = nativeChunk();
    network.mockImplementationOnce(async () => Response.json({ response: reply }));
    const { result } = await runNativeGemini(nativeBody(), { queryParams: [["fields", "candidates,candidates/content/parts/text"]] });
    expect(await result.response.json()).toEqual(reply);
  });

  it("rejects a malformed field mask before any provider admission", async () => {
    const { result } = await runNativeGemini(nativeBody(), { queryParams: [["fields", "candidates(content"]] });
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({ error: { code: 400, status: "INVALID_ARGUMENT" } });
    expect(network).not.toHaveBeenCalled();
  });

  it("a valid field mask never hides an error inside a successful provider envelope", async () => {
    const error = { error: { code: 400, status: "INVALID_ARGUMENT", message: "fixture failure", details: [{ reason: "keep" }] } };
    network.mockImplementationOnce(async () => Response.json({ response: error }));
    const { result } = await runNativeGemini(nativeBody(), { queryParams: [["fields", "candidates/content/parts/text"]] });
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual(error);
  });

  it("keeps the existing system branding mask without rewriting task data or mutating the caller", async () => {
    const original = nativeBody();
    original.systemInstruction.parts[0].text = "OpenCode: follow the task protocol.";
    original.contents[0].parts[0].text = "Read OpenCode/format.json";
    const before = structuredClone(original);
    const { result } = await runNativeGemini(original);
    expect(wireRequest().request.systemInstruction.parts[0].text).toBe("Antigravity: follow the task protocol.");
    expect(wireRequest().request.contents).toEqual(original.contents);
    expect(original).toEqual(before);
    await result.response.text();
  });

  it("unwraps a JSON-array stream without converting it to SSE or losing late usage", async () => {
    const first = nativeChunk("модель готова");
    const lateUsage = { usageMetadata: { promptTokenCount: 41, cachedContentTokenCount: 32, totalTokenCount: 41 } };
    const raw = JSON.stringify([{ response: first }, { response: lateUsage }], null, 2);
    network.mockImplementationOnce(async () => new Response(byteFragmentedStream(raw), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));

    const { result } = await runNativeGemini(nativeBody(), { stream: true });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(JSON.parse(await result.response.text())).toEqual([first, lateUsage]);
  });

  it("reports a clean EOF before a candidate finishes as an incomplete native JSON stream", async () => {
    const partial = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "unfinished" }] } }] };
    network.mockImplementationOnce(async () => new Response(JSON.stringify([{ response: partial }]), {
      headers: { "Content-Type": "application/json" },
    }));

    const { result } = await runNativeGemini(nativeBody(), { stream: true });
    expect(result.success).toBe(true);
    await expect(result.response.text()).rejects.toThrow(/Upstream Gemini JSON stream|candidate finished/i);
  });

  it("does not invent a Gemini finish reason when an Antigravity SSE stream ends early", async () => {
    const partial = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "unfinished" }] } }] };
    network.mockImplementationOnce(async () => new Response(byteFragmentedStream(sseFrame({ response: partial })), {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const { result } = await runNativeGemini(nativeBody(), { stream: true, queryParams: [["alt", "sse"]] });
    const output = await result.response.text();
    expect(output).toContain('"text":"unfinished"');
    expect(output).toContain('"code":502');
    expect(output).not.toContain('"finishReason":"STOP"');
    expect(output).not.toContain("[DONE]");
  });

  it("keeps native provider error details and does not mark the request successful", async () => {
    const error = { error: { code: 400, status: "INVALID_ARGUMENT", message: "fixture rejected", details: [{ field: "toolConfig" }] } };
    const onRequestSuccess = vi.fn();
    network.mockImplementationOnce(async () => Response.json(error, {
      status: 400,
      headers: { "Retry-After": "17" },
    }));

    const { result } = await runNativeGemini(nativeBody(), { onRequestSuccess });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("retry-after")).toBe("17");
    expect(await result.response.json()).toEqual(error);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledOnce();
  });

  it("turns an Antigravity HTTP-200 error envelope into the native Gemini error response", async () => {
    const error = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "fixture quota", details: [{ retryDelay: "9s" }] } };
    const onRequestSuccess = vi.fn();
    network.mockImplementationOnce(async () => Response.json({ response: error }));

    const { result } = await runNativeGemini(nativeBody(), { onRequestSuccess });
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(429);
    expect(await result.response.json()).toEqual(error);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it.each([[null], [[]], [{}], ["invalid"]])("does not treat a malformed envelope with trace metadata as a successful unary response: %j", async response => {
    network.mockImplementationOnce(async () => Response.json({ response, serverTrace: "fixture" }));
    const { result } = await runNativeGemini();
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(await result.response.json()).toMatchObject({ error: { code: 502, message: "Invalid Antigravity response envelope" } });
  });

  it("cancelling the client stream cancels the Antigravity request", async () => {
    let upstreamCancelled;
    const cancelled = new Promise(resolve => { upstreamCancelled = resolve; });
    let executorSignal;
    const firstFrame = sseFrame({ response: nativeChunk("partial") });
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(firstFrame)); },
      cancel: upstreamCancelled,
    });
    network.mockImplementationOnce(async (_url, options) => {
      executorSignal = options.signal;
      return new Response(upstream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const { result } = await runNativeGemini(nativeBody(), { stream: true });
    const reader = result.response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("fixture client cancelled");
    await vi.waitFor(() => expect(executorSignal.aborted).toBe(true));
    await expect(cancelled).resolves.toBeDefined();
  });

  it("leaves the Antigravity Claude request path on its existing translated wrapper", async () => {
    const request = {
      model: "antigravity/claude-sonnet-4-6",
      messages: [{ role: "user", content: "Keep this Claude prompt." }],
      max_tokens: 1024,
      tools: [{ name: "lookup_record", description: "Look up", input_schema: { type: "object", properties: { key: { type: "string" } } } }],
    };
    network.mockImplementationOnce(async () => Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "fixture stop" } }, { status: 400 }));
    const credentials = makeCredentials();
    const result = await handleChatCore({
      body: request,
      modelInfo: { provider: "antigravity", model: "claude-sonnet-4-6" },
      sourceFormatOverride: FORMATS.CLAUDE,
      credentials,
      clientRawRequest: { endpoint: "/v1/messages", body: structuredClone(request), headers: {}, queryParams: [] },
      connectionId: credentials.connectionId,
      log: quiet,
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: false,
    });
    expect(result.success).toBe(false);
    expect(supportsNativeGemini("antigravity", "claude-sonnet-4-6")).toBe(false);
    expect(credentials.nativeGeminiPassthrough).toBe(false);
    const wire = wireRequest();
    expect(wire.userAgent).toBe("antigravity");
    expect(wire.request.contents[0]).toMatchObject({ role: "user", parts: [{ text: "Keep this Claude prompt." }] });
    expect(wire.request.tools[0].functionDeclarations.map(fn => fn.name)).toContain("lookup_record");
  });
});

describe("Gemini endpoint source selection for Antigravity", () => {
  it("routes only supported Antigravity Gemini models through native Gemini core input", async () => {
    expect(supportsNativeGemini("antigravity", MODEL)).toBe(true);
    expect(supportsNativeGemini("antigravity", "claude-sonnet-4-6")).toBe(false);
    expect(supportsNativeGemini("antigravity", "gemini-3.1-flash-image")).toBe(false);

    network.mockReset();
    executorInstances.clear();
    const reply = { candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{
      functionCall: { id: "returned-call", name: "lookup_record", args: { key: "actual-request" } }, thoughtSignature: "returned-state",
    }] } }], usageMetadata: { cachedContentTokenCount: 4096 } };
    network.mockImplementationOnce(async () => Response.json({ response: reply }));

    const { context, services } = loadRouteHarness();
    const original = nativeBody();
    const url = `https://router.test/v1beta/models/antigravity/${MODEL}:generateContent?alt=json&trace=fixture&key=router-key`;
    const request = new Request(url, {
      method: "POST",
      headers: { Authorization: "Bearer router-key", "Content-Type": "application/json" },
      body: JSON.stringify(original),
    });
    const response = await context.POST(request, {
      params: Promise.resolve({ path: ["antigravity", `${MODEL}:generateContent`] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(reply);
    expect(services.handleChatCore).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledOnce();
    const options = services.handleChatCore.mock.calls[0][0];
    expect(options.modelInfo).toEqual({ provider: "antigravity", model: MODEL });
    expect(options.sourceFormatOverride).toBe("gemini");
    expect(options.body).toEqual({ ...original, model: `antigravity/${MODEL}`, stream: false });
    expect(options.clientRawRequest.body).toEqual(original);
    expect(options.clientRawRequest.queryParams).toEqual([["alt", "json"], ["trace", "fixture"]]);
    expect(options.credentials.nativeGeminiPassthrough).toBe(true);
    expect(wireRequest().request.contents[1].parts).toContainEqual({
      functionCall: { id: "call-native-17", name: "lookup_record", args: { key: "opaque-9" } },
      thoughtSignature: "native-call-signature",
    });
  });

  it("wraps real fetch failures after account fallback exhaustion in the Gemini error envelope", async () => {
    const { context, services } = loadRouteHarness();
    const executor = new AntigravityExecutor();
    executor.config = {
      ...executor.config,
      retry: { ...(executor.config.retry || {}), 502: { attempts: 0, delayMs: 0 } },
    };
    executorInstances.set("antigravity", executor);

    const credentials = connectionId => ({
      accessToken: `offline-token-${connectionId}`,
      projectId: "fixture-project",
      connectionId,
      providerSpecificData: {},
    });
    services.getProviderCredentials.mockReset()
      .mockResolvedValueOnce(credentials("first-account"))
      .mockResolvedValueOnce(credentials("second-account"))
      .mockResolvedValueOnce(null);
    services.markAccountUnavailable.mockReset()
      .mockResolvedValueOnce({ shouldFallback: true })
      .mockResolvedValueOnce({ shouldFallback: true });
    network.mockReset()
      .mockRejectedValueOnce(new Error("first account fetch failed"))
      .mockRejectedValueOnce(new Error("second account fetch failed"));

    const response = await postNativeGemini(context);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: {
      code: 502,
      status: "UNAVAILABLE",
      message: expect.stringContaining("second account fetch failed"),
    } });
    expect(network).toHaveBeenCalledTimes(2);
    expect(services.getProviderCredentials).toHaveBeenCalledTimes(3);
  });

  it("uses the latest transport failure after an earlier native quota error", async () => {
    const { context, services } = loadRouteHarness();
    const executor = new AntigravityExecutor();
    executor.config = {
      ...executor.config,
      retry: { ...(executor.config.retry || {}),
        429: { attempts: 0, delayMs: 0 }, 502: { attempts: 0, delayMs: 0 } },
    };
    executorInstances.set("antigravity", executor);
    const credentials = connectionId => ({
      accessToken: `offline-token-${connectionId}`, projectId: "fixture-project",
      connectionId, providerSpecificData: {},
    });
    services.getProviderCredentials.mockReset()
      .mockResolvedValueOnce(credentials("quota-account"))
      .mockResolvedValueOnce(credentials("transport-account"))
      .mockResolvedValueOnce(null);
    services.markAccountUnavailable.mockReset()
      .mockResolvedValueOnce({ shouldFallback: true })
      .mockResolvedValueOnce({ shouldFallback: true });
    network.mockReset()
      .mockResolvedValueOnce(Response.json({ error: {
        code: 429, status: "RESOURCE_EXHAUSTED", message: "earlier quota error",
      } }, { status: 429, headers: { "Retry-After": "13" } }))
      .mockRejectedValueOnce(new Error("latest account transport failed"));

    const response = await postNativeGemini(context);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: {
      code: 502, status: "UNAVAILABLE",
      message: expect.stringContaining("latest account transport failed"),
    } });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(network).toHaveBeenCalledTimes(2);
    expect(services.getProviderCredentials).toHaveBeenCalledTimes(3);
  });

  it("preserves a marked upstream Gemini error body and headers through account fallback", async () => {
    const { context, services } = loadRouteHarness();
    const raw = '{ "error": { "code": 400, "status": "INVALID_ARGUMENT", "message": "native upstream detail", "details": [{"field":"contents"}] } }';
    services.getProviderCredentials.mockReset()
      .mockResolvedValueOnce({
        accessToken: "offline-provider-token",
        projectId: "fixture-project",
        connectionId: "first-account",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce(null);
    services.markAccountUnavailable.mockReset().mockResolvedValueOnce({ shouldFallback: true });
    network.mockReset().mockResolvedValueOnce(new Response(raw, { status: 400, headers: {
      "Content-Type": "application/json",
      "Retry-After": "13",
      "X-Google-Trace": "native-trace",
    } }));

    const response = await postNativeGemini(context);

    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBe("13");
    expect(response.headers.get("x-google-trace")).toBe("native-trace");
    expect(await response.text()).toBe(raw);
    expect(network).toHaveBeenCalledOnce();
  });

  it("returns the Gemini status field for unexpected route failures", async () => {
    const { context, services } = loadRouteHarness();
    services.getModelInfo.mockRejectedValueOnce(new Error("fixture route setup failed"));

    const response = await postNativeGemini(context);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: {
      code: 500,
      status: "INTERNAL",
      message: "fixture route setup failed",
    } });
  });
});
