// Native Gemini JSON-output regression coverage through the public route, real
// chat core, and real Antigravity executor. Only the upstream network boundary
// and accounting services are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
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

function jsonRequestBody() {
  return {
    systemInstruction: { parts: [{ text: "Follow the task protocol." }] },
    contents: [
      { role: "user", parts: [{ text: "Read the attached image and return its code as JSON." }] },
      { role: "model", parts: [
        { text: "Earlier reasoning that remains available.", thought: true, thoughtSignature: "history-thought-signature" },
        { functionCall: { id: "history-call-23", name: "lookup_record", args: { key: "opaque-9" } }, thoughtSignature: "history-call-signature" },
      ] },
      { role: "user", parts: [
        { functionResponse: { id: "history-call-23", name: "lookup_record", response: { record: { kind: "customer", value: 17 } } } },
        { inlineData: { mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" } },
        { providerOpaquePart: { version: 4, identity: "preserve-me" } },
      ] },
    ],
    tools: [{ functionDeclarations: [{
      name: "forbidden_dummy",
      description: "Declared but disabled by native toolConfig.",
      parametersJsonSchema: { type: "OBJECT", properties: { code: { type: "STRING" } } },
    }] }],
    toolConfig: { functionCallingConfig: { mode: "NONE", allowedFunctionNames: ["forbidden_dummy"] } },
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0,
      thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "OBJECT",
        properties: { code: { type: "STRING" } },
        required: ["code"],
        additionalProperties: false,
      },
    },
    cachedContent: "cachedContents/native-prefix",
    clientExtension: { continuation: { kind: "delegated-task", token: "opaque-client-state" } },
  };
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
  // Production crypto is real; these remote fixtures have no trusted local/CLI principal.
  Object.assign(context, { createHash, isLocalRequest: () => false, hasValidCliToken: async () => false });
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

async function postNative(body = jsonRequestBody(), { stream = false, alt, headers = {} } = {}) {
  const { context, services } = loadPublicNativeRoute();
  const action = stream ? "streamGenerateContent" : "generateContent";
  const modelPath = `antigravity/${MODEL}:${action}`;
  const query = alt ? `?alt=${encodeURIComponent(alt)}` : "";
  const request = new Request(`https://router.test/v1beta/models/${modelPath}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer router-client-key", ...headers },
    body: JSON.stringify(body),
  });
  const response = await context.POST(request, {
    params: Promise.resolve({ path: [`antigravity`, `${MODEL}:${action}`] }),
  });
  return { response, services };
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function byteFragmentedStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 23) {
        controller.enqueue(bytes.slice(offset, offset + 23));
      }
      controller.close();
    },
  });
}

function parseSseEvents(text) {
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data)];
  });
}

function nativeTextParts(response, index = 0) {
  return (response.candidates || [])
    .filter(candidate => candidate.index === index)
    .flatMap(candidate => candidate.content?.parts || [])
    .filter(part => typeof part.text === "string" && !part.thought);
}

describe("native Gemini JSON output through public Antigravity route", () => {
  beforeEach(() => {
    network.mockReset();
    executorInstances.clear();
    network.mockImplementation(async () => Response.json({
      response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
    }));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("DIRECT_NETWORK_FORBIDDEN"); }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("removes only the enclosing JSON fence on unary STOP and preserves the native request and response fields", async () => {
    const requestBody = jsonRequestBody();
    const inputCopy = structuredClone(requestBody);
    const providerResponse = {
      candidates: [
        {
          index: 3,
          content: { role: "model", parts: [
            { text: "```json\n{\"code\":\"4821\"}\n```", providerPartMeta: { part: 1 } },
            { text: "private thought", thought: true, thoughtSignature: "provider-thought-signature", providerThoughtMeta: "keep" },
          ] },
          finishReason: "STOP",
          providerCandidateMeta: { identity: "candidate-3" },
        },
        {
          index: 9,
          content: { role: "model", parts: [{
            functionCall: { id: "provider-function-call-91", name: "forbidden_dummy", args: { code: "4821" } },
            thoughtSignature: "provider-function-signature",
            providerPartMeta: "keep-function-part",
          }] },
          finishReason: "STOP",
          providerCandidateMeta: { identity: "candidate-9" },
        },
      ],
      usageMetadata: { promptTokenCount: 81, candidatesTokenCount: 12, totalTokenCount: 93, cachedContentTokenCount: 64 },
      modelVersion: "gemini-3.8-flash-high",
      responseId: "provider-response-id-17",
      providerEnvelopeMeta: { source: "antigravity", sequence: 11 },
    };
    network.mockImplementationOnce(async () => Response.json({ response: providerResponse, cloudCodeTrace: "keep-envelope-metadata" }));

    const { response, services } = await postNative(requestBody);
    expect(response.status).toBe(200);
    const returned = await response.json();
    expect(JSON.parse(nativeTextParts(returned, 3).map(part => part.text).join(""))).toEqual({ code: "4821" });
    expect(nativeTextParts(returned, 3).map(part => part.text).join("")).toBe('{"code":"4821"}\n');
    expect(returned.candidates.map(candidate => candidate.index)).toEqual([3, 9]);
    expect(returned.candidates[0].providerCandidateMeta).toEqual({ identity: "candidate-3" });
    expect(returned.candidates[0].content.parts[0]).toMatchObject({
      providerPartMeta: { part: 1 },
    });
    expect(returned.candidates[0].content.parts[1]).toMatchObject({
      text: "private thought",
      thought: true,
      thoughtSignature: "provider-thought-signature",
      providerThoughtMeta: "keep",
    });
    expect(returned.candidates[1].content.parts[0]).toMatchObject({
      functionCall: { id: "provider-function-call-91", name: "forbidden_dummy", args: { code: "4821" } },
      thoughtSignature: "provider-function-signature",
      providerPartMeta: "keep-function-part",
    });
    expect(returned.usageMetadata).toEqual(providerResponse.usageMetadata);
    expect(returned.modelVersion).toBe(providerResponse.modelVersion);
    expect(returned.responseId).toBe(providerResponse.responseId);
    expect(returned.providerEnvelopeMeta).toEqual(providerResponse.providerEnvelopeMeta);

    expect(network).toHaveBeenCalledOnce();
    expect(services.handleChatCore).toHaveBeenCalledOnce();
    const wire = JSON.parse(network.mock.calls[0][1].body);
    expect(wire.request.generationConfig).toEqual(inputCopy.generationConfig);
    expect(wire.request.toolConfig).toEqual(inputCopy.toolConfig);
    expect(wire.request.tools).toEqual(inputCopy.tools);
    expect(wire.request.contents).toEqual(inputCopy.contents);
    expect(wire.request.cachedContent).toBe(inputCopy.cachedContent);
    expect(wire.request.clientExtension).toEqual(inputCopy.clientExtension);
    expect(wire.request.generationConfig.responseJsonSchema).toEqual(inputCopy.generationConfig.responseJsonSchema);
    expect(wire.request.generationConfig.responseSchema).toBeUndefined();
    expect(wire.request.generationConfig.responseMimeType).toBe("application/json");
    expect(wire.request.generationConfig.maxOutputTokens).toBe(2048);
    expect(wire.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "HIGH", includeThoughts: true });
    expect(wire.request.toolConfig.functionCallingConfig).toEqual({ mode: "NONE", allowedFunctionNames: ["forbidden_dummy"] });
    expect(requestBody).toEqual(inputCopy);
    expect(wire).not.toHaveProperty("requestType");
    expect(wire.userAgent).toBe("antigravity");
    expect(wire.requestId).toMatch(/^agent\/.+\/\d+\/.+\/\d+$/);
    expect(new Headers(network.mock.calls[0][1].headers).get("authorization")).toBe("Bearer offline-token");
    expect(new Headers(network.mock.calls[0][1].headers).get("user-agent")).toBe(ANTIGRAVITY_HEADERS["User-Agent"]);
  });

  it("normalizes a signed ordinary JSON part and retransmits its exact signature in native continuation history", async () => {
    const ordinarySignature = "eyJwcm92aWRlciI6ImFudGlncmF2aXR5Iiwic2Vzc2lvbiI6InNpZy0xIn0=";
    const thoughtSignature = "eyJ0aG91Z2h0IjoiaGlzdG9yeS1zaWduYXR1cmUifQ==";
    const thoughtPart = { text: "thought before ordinary output", thought: true, thoughtSignature, providerThoughtMeta: "keep-thought" };
    const signedFencedPart = {
      text: "```json\n{\"code\":\"4821\"}\n```",
      thoughtSignature: ordinarySignature,
      providerPartMeta: { carrier: "ordinary-text", sequence: 1 },
    };
    const firstProviderReply = {
      candidates: [{
        index: 12,
        content: { role: "model", parts: [thoughtPart, signedFencedPart] },
        finishReason: "STOP",
        providerCandidateMeta: "signed-candidate",
      }],
      usageMetadata: { promptTokenCount: 91, candidatesTokenCount: 8, totalTokenCount: 99, cachedContentTokenCount: 64 },
      providerEnvelopeMeta: { trace: "signed-unary" },
    };
    const continuationReply = {
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{
          text: "{\"continued\":true}",
          thoughtSignature: ordinarySignature,
          providerPartMeta: { carrier: "ordinary-text", sequence: 2 },
        }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 102, candidatesTokenCount: 4, totalTokenCount: 106 },
    };
    network
      .mockImplementationOnce(async () => Response.json({ response: firstProviderReply }))
      .mockImplementationOnce(async () => Response.json({ response: continuationReply }));

    const { response: firstResponse } = await postNative(jsonRequestBody());
    expect(firstResponse.status).toBe(200);
    const firstReturned = await firstResponse.json();
    const firstParts = firstReturned.candidates[0].content.parts;
    const normalizedSignedPart = { ...signedFencedPart, text: "{\"code\":\"4821\"}\n" };
    expect(firstParts).toEqual([thoughtPart, normalizedSignedPart]);
    expect(JSON.parse(firstParts.filter(part => !part.thought).map(part => part.text).join(""))).toEqual({ code: "4821" });
    expect(firstParts.map(part => part.thoughtSignature)).toEqual([thoughtSignature, ordinarySignature]);
    expect(Buffer.from(firstParts[1].thoughtSignature, "utf8")).toEqual(Buffer.from(ordinarySignature, "utf8"));
    expect(firstReturned.providerEnvelopeMeta).toEqual({ trace: "signed-unary" });
    expect(firstReturned.usageMetadata.cachedContentTokenCount).toBe(64);

    const continuationBody = jsonRequestBody();
    continuationBody.contents = [
      ...continuationBody.contents,
      { role: "model", parts: structuredClone(firstParts) },
      { role: "user", parts: [{ text: "Continue from the normalized model result." }] },
    ];
    const continuationBefore = structuredClone(continuationBody);
    const { response: continuationResponse } = await postNative(continuationBody);
    expect(continuationResponse.status).toBe(200);
    const continuationWire = JSON.parse(network.mock.calls[1][1].body);
    expect(continuationWire.request.contents).toEqual(continuationBody.contents);
    expect(continuationWire.request.contents[3].parts).toEqual(firstParts);
    expect(continuationWire.request.contents[3].parts[1].thoughtSignature).toBe(ordinarySignature);
    expect(continuationBody).toEqual(continuationBefore);
    const continuationReturned = await continuationResponse.json();
    const continuationText = nativeTextParts(continuationReturned).map(part => part.text).join("");
    expect(JSON.parse(continuationText)).toEqual({ continued: true });
    expect(continuationReturned.candidates[0].content.parts[0].thoughtSignature).toBe(ordinarySignature);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("strips fence fragments across SSE events and retains candidate, thought, function, and late usage data in order", async () => {
    const chunks = [
      { response: { candidates: [{ index: 4, content: { role: "model", parts: [{ text: "```json\n{" }] } }] } },
      { response: { candidates: [{ index: 4, content: { role: "model", parts: [
        { text: "\"code\":\"4821\"", providerPartMeta: "middle" },
        { text: "private thought", thought: true, thoughtSignature: "stream-thought-signature" },
      ] } }] } },
      { response: { candidates: [{ index: 4, content: { role: "model", parts: [{ text: "}\n```" }] }, finishReason: "STOP", providerCandidateMeta: "candidate-four" }] } },
      { response: { candidates: [{ index: 8, content: { role: "model", parts: [{ functionCall: { id: "stream-function-16", name: "forbidden_dummy", args: { code: "4821" } }, thoughtSignature: "stream-function-signature" }] }, finishReason: "STOP" }] } },
      { response: { usageMetadata: { promptTokenCount: 81, candidatesTokenCount: 12, totalTokenCount: 93, cachedContentTokenCount: 64 }, providerTailMeta: "late-usage" } },
    ];
    const upstream = chunks.map(sseFrame).join("");
    network.mockImplementationOnce(async () => new Response(byteFragmentedStream(upstream), {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const { response } = await postNative(jsonRequestBody(), { stream: true, alt: "sse" });
    expect(response.status).toBe(200);
    const events = parseSseEvents(await response.text());
    const candidateIndexes = [];
    for (const event of events) {
      for (const candidate of event.candidates || []) {
        if (!candidateIndexes.includes(candidate.index)) candidateIndexes.push(candidate.index);
      }
    }
    expect(candidateIndexes).toEqual([4, 8]);
    const ordinaryText = nativeTextParts({ candidates: events.flatMap(event => event.candidates || []) }, 4)
      .map(part => part.text).join("");
    expect(JSON.parse(ordinaryText)).toEqual({ code: "4821" });
    expect(ordinaryText).toBe('{"code":"4821"}\n');

    const allParts = events.flatMap(event => event.candidates || []).flatMap(candidate => candidate.content?.parts || []);
    expect(allParts.some(part => part.thoughtSignature === "stream-thought-signature" && part.thought === true)).toBe(true);
    expect(allParts.find(part => part.functionCall)?.functionCall).toEqual({
      id: "stream-function-16", name: "forbidden_dummy", args: { code: "4821" },
    });
    const lateUsageIndex = events.findIndex(event => event.usageMetadata?.cachedContentTokenCount === 64);
    const lastCandidateIndex = events.reduce((last, event, index) => event.candidates?.length ? index : last, -1);
    expect(lateUsageIndex).toBeGreaterThan(lastCandidateIndex);
    expect(events[lateUsageIndex]).toMatchObject({
      usageMetadata: { promptTokenCount: 81, candidatesTokenCount: 12, totalTokenCount: 93, cachedContentTokenCount: 64 },
      providerTailMeta: "late-usage",
    });
    expect(network).toHaveBeenCalledOnce();
  });

  it("strips fence fragments from signed ordinary-text SSE parts without changing signature bytes or part positions", async () => {
    const signatureValues = [
      "eyJ0aG91Z2h0IjoiMSJ9",
      "eyJvcmRpbmFyeSI6Im9wZW5pbmcifQ==",
      "eyJ0aG91Z2h0IjoiMiJ9",
      "eyJvcmRpbmFyeSI6Im1pZGRsZSJ9",
      "eyJ0aG91Z2h0IjoiMyJ9",
      "eyJvcmRpbmFyeSI6ImNsb3NpbmcifQ==",
    ];
    const thoughtParts = [
      { text: "thought-1", thought: true, thoughtSignature: signatureValues[0], providerThoughtMeta: 1 },
      { text: "thought-2", thought: true, thoughtSignature: signatureValues[2], providerThoughtMeta: 2 },
      { text: "thought-3", thought: true, thoughtSignature: signatureValues[4], providerThoughtMeta: 3 },
    ];
    const signedTextParts = [
      { text: "```json\n{", thoughtSignature: signatureValues[1], providerPartMeta: { fragment: "opening" } },
      { text: "\"code\":\"4821\"", thoughtSignature: signatureValues[3], providerPartMeta: { fragment: "middle" } },
      { text: "}\n```", thoughtSignature: signatureValues[5], providerPartMeta: { fragment: "closing" } },
    ];
    const chunks = [
      { response: { candidates: [{ index: 15, content: { role: "model", parts: [thoughtParts[0], signedTextParts[0]] } }] } },
      { response: { candidates: [{ index: 15, content: { role: "model", parts: [thoughtParts[1], signedTextParts[1]] } }] } },
      { response: { candidates: [{ index: 15, content: { role: "model", parts: [thoughtParts[2], signedTextParts[2]] }, finishReason: "STOP" }] } },
      { response: { usageMetadata: { promptTokenCount: 91, candidatesTokenCount: 8, totalTokenCount: 99, cachedContentTokenCount: 64 }, providerTailMeta: "late-usage" } },
    ];
    network.mockImplementationOnce(async () => new Response(byteFragmentedStream(chunks.map(sseFrame).join("")), {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const { response } = await postNative(jsonRequestBody(), { stream: true, alt: "sse" });
    expect(response.status).toBe(200);
    const events = parseSseEvents(await response.text());
    const candidateEvents = events.flatMap(event => event.candidates || []).filter(candidate => candidate.index === 15);
    expect(candidateEvents).toHaveLength(3);
    const expectedText = ["{", "\"code\":\"4821\"", "}\n"];
    for (let index = 0; index < candidateEvents.length; index++) {
      expect(candidateEvents[index].content.parts).toEqual([
        thoughtParts[index],
        { ...signedTextParts[index], text: expectedText[index] },
      ]);
    }
    const ordinaryText = candidateEvents.flatMap(candidate => candidate.content.parts)
      .filter(part => !part.thought && typeof part.text === "string")
      .map(part => part.text).join("");
    expect(JSON.parse(ordinaryText)).toEqual({ code: "4821" });
    expect(ordinaryText).toBe('{"code":"4821"}\n');

    const returnedSignatures = candidateEvents.flatMap(candidate => candidate.content.parts)
      .map(part => part.thoughtSignature);
    expect(returnedSignatures).toEqual(signatureValues);
    for (let index = 0; index < returnedSignatures.length; index++) {
      expect(Buffer.from(returnedSignatures[index], "utf8")).toEqual(Buffer.from(signatureValues[index], "utf8"));
    }
    const lateUsageIndex = events.findIndex(event => event.usageMetadata?.cachedContentTokenCount === 64);
    const lastCandidateIndex = events.reduce((last, event, index) => event.candidates?.length ? index : last, -1);
    expect(lateUsageIndex).toBeGreaterThan(lastCandidateIndex);
    expect(events[lateUsageIndex]).toMatchObject({
      usageMetadata: { promptTokenCount: 91, candidatesTokenCount: 8, totalTokenCount: 99, cachedContentTokenCount: 64 },
      providerTailMeta: "late-usage",
    });
    expect(network).toHaveBeenCalledOnce();
  });

  it.each([
    ["JSON MIME without schema", body => { delete body.generationConfig.responseJsonSchema; }],
    ["no JSON MIME", body => { delete body.generationConfig.responseMimeType; delete body.generationConfig.responseJsonSchema; }],
    ["non-JSON MIME", body => { body.generationConfig.responseMimeType = "text/plain"; delete body.generationConfig.responseJsonSchema; }],
  ])("selects JSON output only for explicit application/json MIME: %s", async (name, changeBody) => {
    const body = jsonRequestBody();
    changeBody(body);
    const fenced = "```json\n{\"code\":\"4821\"}\n```";
    network.mockImplementationOnce(async () => Response.json({ response: {
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: fenced }] }, finishReason: "STOP" }],
    } }));

    const { response } = await postNative(body);
    expect(response.status).toBe(200);
    const candidateText = (await response.json()).candidates[0].content.parts[0].text;
    if (name === "JSON MIME without schema") expect(candidateText).toBe('{"code":"4821"}\n');
    else expect(candidateText).toBe(fenced);
  });

  it.each([
    ["malformed JSON", "```json\n{\"code\":}\n```", "STOP"],
    ["unfinished candidate", "```json\n{\"code\":\"4821\"}\n```", undefined],
    ["MAX_TOKENS candidate", "```json\n{\"code\":\"4821\"}\n```", "MAX_TOKENS"],
  ])("does not sanitize %s", async (_name, fenced, finishReason) => {
    const candidate = { index: 0, content: { role: "model", parts: [{ text: fenced }] } };
    if (finishReason !== undefined) candidate.finishReason = finishReason;
    network.mockImplementationOnce(async () => Response.json({ response: { candidates: [candidate] } }));

    const { response } = await postNative();
    expect(response.status).toBe(200);
    expect((await response.json()).candidates[0].content.parts[0].text).toBe(fenced);
  });

  it("passes provider errors through without treating error text as JSON output", async () => {
    const error = { error: { code: 400, status: "INVALID_ARGUMENT", message: "structured output rejected", details: [{ field: "generationConfig.responseJsonSchema" }] } };
    network.mockImplementationOnce(async () => Response.json(error, { status: 400, headers: { "Retry-After": "11" } }));

    const { response } = await postNative();
    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBe("11");
    expect(await response.json()).toEqual(error);
  });

  it("preserves an HTTP-200 Gemini error envelope", async () => {
    const error = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "provider quota", details: [{ retryDelay: "4s" }] } };
    network.mockImplementationOnce(async () => Response.json({ response: error }));

    const { response } = await postNative();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(error);
  });

  it("does not synthesize a JSON completion for an incomplete fenced SSE stream", async () => {
    const incomplete = sseFrame({ response: {
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: "```json\n{\"code\":\"4821\"}" }] } }],
    } });
    network.mockImplementationOnce(async () => new Response(byteFragmentedStream(incomplete), {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const { response } = await postNative(jsonRequestBody(), { stream: true, alt: "sse" });
    const output = await response.text();
    expect(output).toContain("```json");
    expect(output).not.toContain('"finishReason":"STOP"');
    expect(output).toContain('"code":502');
    expect(output).not.toContain("[DONE]");
  });

  it("cancels the upstream stream while an opening fence is still buffered", async () => {
    let upstreamCancelled;
    const cancelled = new Promise(resolve => { upstreamCancelled = resolve; });
    let executorSignal;
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseFrame({ response: {
          candidates: [{ index: 0, content: { role: "model", parts: [{ text: "```j" }] } }],
        } })));
      },
      cancel: upstreamCancelled,
    });
    network.mockImplementationOnce(async (_url, options) => {
      executorSignal = options.signal;
      return new Response(upstream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const { response } = await postNative(jsonRequestBody(), { stream: true, alt: "sse" });
    const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel("fixture client cancelled during JSON fence");
    await vi.waitFor(() => expect(executorSignal.aborted).toBe(true));
    await expect(cancelled).resolves.toBeUndefined();
  });
});
