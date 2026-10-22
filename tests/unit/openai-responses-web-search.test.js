import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { getGeminiThoughtSignatureSync } from "../../open-sse/services/thoughtSignatureStore.js";
import { MODEL_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

const MODEL = "gemini-3.8-flash";
const TENANT_A = "authenticated-api-key-tenant-a";
const TENANT_B = "authenticated-api-key-tenant-b";
const TRUSTED_LOCAL = "trusted-local";
const TRUSTED_CLI = "trusted-cli";

const translateForTenant = (source, target, model, body, credentials, provider, tenant = TENANT_A, connectionId = null) =>
  translateRequest(source, target, model, body, true, credentials, provider, null, [], connectionId, null, tenant);

const recordVersion = () => ({
  type: "function",
  name: "record_version",
  description: "Record the discovered version.",
  parameters: { type: "object", properties: { version: { type: "string" } }, required: ["version"], additionalProperties: false },
});

const userMessage = () => ({ type: "message", role: "user", content: [{ type: "input_text", text: "Use Google Search to find the Node.js LTS version, then call record_version." }] });

const requestBody = (tools) => ({
  model: MODEL,
  instructions: "You are a precise assistant.",
  tools,
  input: [userMessage()],
  tool_choice: "auto",
});

const webSearch = { type: "web_search", external_web_access: true };

// Shapes follow the live AIStudio probe (websearch-probe/aistudio.json): thought text,
// then alternating toolCall/toolResponse parts, then a thought, then the functionCall.
const thought = (text) => ({ text, thought: true });
const searchCall = (id, sig, queries) => ({ thoughtSignature: sig, toolCall: { toolType: "GOOGLE_SEARCH_WEB", args: { queries }, id } });
const searchResponse = (id, sig, payload) => ({ thoughtSignature: sig, toolResponse: { toolType: "GOOGLE_SEARCH_WEB", response: payload, id } });
const CALL_SIG = "call-signature";
const probeParts = [
  thought("Plan: search, then record."),
  searchCall("call_393179", "sig-1", ["Node js releases LTS", "Node js current LTS version"]),
  searchResponse("call_393179", "sig-2", { search_suggestions: "<style>.c{display:flex}</style>", results: "v24.21.0 LTS, v26.11.1 Current" }),
  thought("The LTS line is 24.x."),
  searchCall("call_393227", "sig-3", ["\"record_version\" node lts"]),
  searchResponse("call_393227", "sig-4", { search_suggestions: "<style/>.chip{padding:5px}</style>", results: "24.21.0 is LTS" }),
  thought("24.21.0 is the current LTS."),
  { functionCall: { name: "record_version", args: { version: "24.21.0" }, id: "call_393372" }, thoughtSignature: CALL_SIG },
];
const serverParts = probeParts.filter(part => part.toolCall || part.toolResponse);

const nativeResponse = (parts) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 602, candidatesTokenCount: 22, thoughtsTokenCount: 1357, totalTokenCount: 1981 },
  modelVersion: MODEL,
});

async function runStream(chunks, credentials) {
  const input = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join(""))); controller.close(); } });
  const transform = createSSETransformStreamWithLogger(FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, "aistudio", null, null, MODEL, null, null, null, null, null, credentials);
  const raw = await new Response(input.pipeThrough(transform)).text();
  return raw.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
}

describe("Responses web_search request translation", () => {
  it.each(["gemini", "aistudio"])("keeps hosted search available on configured Gemini 4 through %s", provider => {
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI,
      "gemini/gemini-4-argon", requestBody([recordVersion(), webSearch]), true, {}, provider);
    expect(translated.tools).toContainEqual({ googleSearch: {} });
    expect(translated.toolConfig.includeServerSideToolInvocations).toBe(true);
    expect("_webSearch" in translated).toBe(false);
  });

  it("uses the declared model capability rather than a model-name pattern", () => {
    const model = "configured-hosted-search-fixture";
    const previous = MODEL_CAPABILITIES[model];
    try {
      MODEL_CAPABILITIES[model] = { search: true, serverSideToolInvocations: true };
      const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI,
        model, requestBody([webSearch]), true, {}, "gemini");
      expect(translated.tools).toContainEqual({ googleSearch: {} });
      expect(translated.toolConfig.includeServerSideToolInvocations).toBe(true);
      MODEL_CAPABILITIES[model] = { search: true, serverSideToolInvocations: false };
      const unsupported = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI,
        model, requestBody([webSearch]), true, {}, "gemini");
      expect(unsupported.tools || []).not.toContainEqual({ googleSearch: {} });
    } finally {
      if (previous === undefined) delete MODEL_CAPABILITIES[model];
      else MODEL_CAPABILITIES[model] = previous;
    }
  });

  for (const provider of ["gemini", "aistudio"]) {
    it(`enables googleSearch with server-side invocations for ${provider}`, () => {
      const credentials = {};
      const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, requestBody([recordVersion(), webSearch]), true, credentials, provider);
      const kinds = translated.tools.map(t => Object.keys(t)[0]);
      expect(kinds).toContain("googleSearch");
      expect(kinds).toContain("functionDeclarations");
      expect(translated.tools.find(t => t.googleSearch)).toEqual({ googleSearch: {} });
      const declarations = translated.tools.find(t => t.functionDeclarations).functionDeclarations;
      expect(declarations.map(d => d.name)).toEqual(["record_version"]);
      expect(translated.toolConfig.includeServerSideToolInvocations).toBe(true);
      expect(translated.toolConfig.functionCallingConfig).toEqual({ mode: "AUTO" });
      expect("_webSearch" in translated).toBe(false);
      expect(JSON.stringify(translated)).not.toContain("web_search");
    });
  }

  it("enables googleSearch when web_search is the only tool", () => {
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, requestBody([webSearch]), true, {}, "gemini");
    expect(translated.tools).toEqual([{ googleSearch: {} }]);
    expect(translated.toolConfig).toEqual({ includeServerSideToolInvocations: true });
  });

  for (const [label, format, provider, model, tools] of [
    ["antigravity", FORMATS.ANTIGRAVITY, "antigravity", MODEL, undefined],
    ["gemini-cli", FORMATS.GEMINI_CLI, "gemini-cli", MODEL, undefined],
    ["non-Gemini-3 model", FORMATS.GEMINI, "gemini", "gemini-2.5-flash", undefined],
    ["vertex", FORMATS.VERTEX, "vertex", MODEL, undefined],
    ["external_web_access:false", FORMATS.GEMINI, "gemini", MODEL, [{ type: "function", name: "record_version", description: "Record the discovered version.", parameters: { type: "object", properties: { version: { type: "string" } }, required: ["version"], additionalProperties: false } }, { type: "web_search", external_web_access: false }]],
    ["allowed_domains filter", FORMATS.GEMINI, "gemini", MODEL, [{ type: "function", name: "record_version", description: "Record the discovered version.", parameters: { type: "object", properties: { version: { type: "string" } }, required: ["version"], additionalProperties: false } }, { type: "web_search", external_web_access: true, filters: { allowed_domains: ["nodejs.org"] } }]],
  ]) {
    it(`does not enable googleSearch for ${label}`, () => {
      const base = requestBody(tools || [recordVersion(), webSearch]);
      const withSearch = translateRequest(FORMATS.OPENAI_RESPONSES, format, model, base, true, { projectId: "p" }, provider);
      const plain = { ...base, tools: [recordVersion()] };
      const withoutSearch = translateRequest(FORMATS.OPENAI_RESPONSES, format, model, plain, true, { projectId: "p" }, provider);
      const strip = (o) => { const c = structuredClone(o); delete c._webSearch; delete c.requestId; delete c.sessionId; if (c.request) { delete c.request.requestId; delete c.request.sessionId; } return c; };
      expect(strip(withSearch)).toEqual(strip(withoutSearch));
      expect(JSON.stringify(withSearch)).not.toContain("googleSearch");
      expect(JSON.stringify(withSearch)).not.toContain("includeServerSideToolInvocations");
    });
  }

  it("never puts web_search into chat tools for a non-Gemini target", () => {
    const translated = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "gpt-5", requestBody([recordVersion(), webSearch]), true, {}, "openai");
    expect(translated.tools).toHaveLength(1);
    expect(translated.tools[0].function.name).toBe("record_version");
    expect("_webSearch" in translated).toBe(false);
  });
});

describe("server-executed tool parts in responses", () => {
  const session = (sessionId = "web-search-conversation-fixture") => {
    const credentials = { rawHeaders: { session_id: sessionId } };
    translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, requestBody([recordVersion(), webSearch]), credentials, "aistudio");
    return credentials;
  };

  it("streams reasoning and one client function_call; server parts never leak and never steal signatures", async () => {
    const credentials = session();
    const events = await runStream([nativeResponse(probeParts)], credentials);
    const done = events.filter(e => e.type === "response.output_item.done");
    const call = done.find(e => e.item.type === "function_call");
    expect(call.item).toMatchObject({ type: "function_call", name: "record_version", call_id: "call_393372" });
    expect(JSON.parse(call.item.arguments)).toEqual({ version: "24.21.0" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("toolCall");
    expect(serialized).not.toContain("toolResponse");
    expect(serialized).not.toContain("GOOGLE_SEARCH_WEB");
    // The call keeps its own signature, not the preceding toolResponse signature.
    expect(getGeminiThoughtSignatureSync("call_393372", credentials._clientSessionId, MODEL)).toBe(CALL_SIG);
    const reasoning = done.find(e => e.item.type === "reasoning");
    expect(reasoning).toBeTruthy();
  });

  it("does not attach a toolResponse signature to an unsigned functionCall", async () => {
    const credentials = session();
    const parts = [
      searchCall("call_a", "sig-a", ["q"]),
      searchResponse("call_a", "sig-b", { results: "r" }),
      { functionCall: { name: "record_version", args: { version: "1" }, id: "call_unsigned" } },
    ];
    await runStream([nativeResponse(parts)], credentials);
    expect(getGeminiThoughtSignatureSync("call_unsigned", credentials._clientSessionId, MODEL)).toBeNull();
  });

  it("replays stored server parts verbatim before the anchored functionCall", async () => {
    const credentials = session();
    await runStream([nativeResponse(probeParts)], credentials);
    const next = {
      model: MODEL,
      instructions: "You are a precise assistant.",
      tools: [recordVersion(), webSearch],
      input: [
        userMessage(),
        { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
        { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
      ],
    };
    const translated = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, next, credentials, "aistudio");
    const modelTurn = translated.contents.find(c => c.role === "model");
    const fcIndex = modelTurn.parts.findIndex(p => p.functionCall);
    expect(fcIndex).toBeGreaterThan(0);
    const leading = modelTurn.parts.slice(0, fcIndex);
    expect(leading).toEqual(serverParts);
    expect(modelTurn.parts[fcIndex]).toEqual({ functionCall: { id: "call_393372", name: "record_version", args: { version: "24.21.0" } }, thoughtSignature: CALL_SIG });
    const toolTurn = translated.contents.find(c => c.parts?.[0]?.functionResponse);
    expect(toolTurn.parts[0].functionResponse).toMatchObject({ id: "call_393372", name: "record_version" });
  });

  it("anchors server parts to the turn key when the turn ends on text", async () => {
    const credentials = session();
    const textParts = [
      thought("Thinking about the answer."),
      searchCall("call_t1", "sig-t1", ["q"]),
      searchResponse("call_t1", "sig-t2", { results: "found" }),
      { text: "The LTS version is 24.21.0." },
    ];
    const events = await runStream([nativeResponse(textParts)], credentials);
    expect(JSON.stringify(events)).not.toContain("toolCall");
    const next = {
      model: MODEL,
      instructions: "You are a precise assistant.",
      tools: [recordVersion(), webSearch],
      input: [
        userMessage(),
        { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking about the answer." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "The LTS version is 24.21.0." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks." }] },
      ],
    };
    const translated = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, next, credentials, "aistudio");
    const modelTurn = translated.contents.find(c => c.role === "model");
    const textIndex = modelTurn.parts.findIndex(p => p.text === "The LTS version is 24.21.0.");
    const stored = textParts.filter(p => p.toolCall || p.toolResponse);
    expect(modelTurn.parts.slice(textIndex - stored.length, textIndex)).toEqual(stored);
  });

  it("does not replay another session's server parts for the same call id and prompt", async () => {
    const sessionA = session("web-search-session-a");
    await runStream([nativeResponse(probeParts)], sessionA);
    const history = {
      model: MODEL,
      instructions: "You are a precise assistant.",
      tools: [recordVersion(), webSearch],
      input: [
        userMessage(),
        { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
        { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
      ],
    };
    const replayed = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, structuredClone(history), { rawHeaders: { session_id: "web-search-session-a" } }, "aistudio");
    const turnA = replayed.contents.find(c => c.role === "model");
    expect(turnA.parts.slice(0, turnA.parts.findIndex(p => p.functionCall))).toEqual(serverParts);
    const other = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, structuredClone(history), { rawHeaders: { session_id: "web-search-session-b" } }, "aistudio");
    const parts = other.contents.flatMap(c => c.parts);
    expect(parts.some(p => p.toolCall || p.toolResponse)).toBe(false);
    expect(JSON.stringify(other)).not.toContain("GOOGLE_SEARCH_WEB");
    expect(parts.find(p => p.functionCall).functionCall.id).toBe("call_393372");
  });

  it("does not replay server parts across authenticated API-key tenants sharing one session", async () => {
    const sessionId = "shared-client-declared-session";
    const tenantA = session(sessionId);
    await runStream([nativeResponse(probeParts)], tenantA);
    const history = {
      model: MODEL,
      instructions: "You are a precise assistant.",
      tools: [recordVersion(), webSearch],
      input: [
        userMessage(),
        { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
        { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
      ],
    };
    const sameTenant = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, structuredClone(history), { rawHeaders: { session_id: sessionId } }, "aistudio", TENANT_A);
    const replayedParts = sameTenant.contents.flatMap(entry => entry.parts || []);
    expect(replayedParts.some(part => part.toolCall || part.toolResponse)).toBe(true);

    const otherTenant = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, structuredClone(history), { rawHeaders: { session_id: sessionId } }, "aistudio", TENANT_B);
    const isolatedParts = otherTenant.contents.flatMap(entry => entry.parts || []);
    expect(isolatedParts.some(part => part.toolCall || part.toolResponse)).toBe(false);
    expect(isolatedParts.find(part => part.functionCall).functionCall.id).toBe("call_393372");
  });

  it("replays for the trusted local principal without sharing with a distinct authenticated caller", async () => {
    const sessionId = "trusted-local-session";
    const localCredentials = { rawHeaders: { session_id: sessionId } };
    translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, requestBody([recordVersion(), webSearch]), localCredentials, "aistudio", TRUSTED_LOCAL);
    await runStream([nativeResponse(probeParts)], localCredentials);
    const history = {
      model: MODEL,
      instructions: "You are a precise assistant.",
      tools: [recordVersion(), webSearch],
      input: [
        userMessage(),
        { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
        { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
      ],
    };
    const localReplay = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, structuredClone(history), { rawHeaders: { session_id: sessionId } }, "aistudio", TRUSTED_LOCAL);
    expect(localReplay.contents.flatMap(entry => entry.parts || []).some(part => part.toolCall || part.toolResponse)).toBe(true);

    const cliReplay = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, structuredClone(history), { rawHeaders: { session_id: sessionId } }, "aistudio", TRUSTED_CLI);
    expect(cliReplay.contents.flatMap(entry => entry.parts || []).some(part => part.toolCall || part.toolResponse)).toBe(false);
  });

  it("does not cache server parts from a client session without an authenticated tenant", async () => {
    const credentials = { rawHeaders: { session_id: "untrusted-shared-session" } };
    translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, requestBody([recordVersion(), webSearch]), true, credentials, "aistudio");
    expect(credentials._geminiServerPartsSessionId).toBeNull();
    await runStream([nativeResponse(probeParts)], credentials);

    const next = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, {
      ...requestBody([recordVersion(), webSearch]),
      input: [
        userMessage(),
        { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
        { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
      ],
    }, true, credentials, "aistudio");
    expect(next.contents.flatMap(entry => entry.parts || []).some(part => part.toolCall || part.toolResponse)).toBe(false);
  });

  it("never shares plaintext server parts between headerless conversations on one provider credential", async () => {
    const CONNECTION = "selected-provider-credential";
    const history = () => ({
      model: MODEL,
      instructions: "You are a precise assistant.",
      tools: [recordVersion(), webSearch],
      input: [
        userMessage(),
        { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
        { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
      ],
    });
    const open = (body) => {
      const credentials = {};
      const out = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, body, credentials, "aistudio", TENANT_A, CONNECTION);
      return { credentials, out };
    };
    const first = open(requestBody([recordVersion(), webSearch]));
    await runStream([nativeResponse(probeParts)], first.credentials);
    const second = open(history());
    expect(second.credentials._clientSessionId).toBe(first.credentials._clientSessionId);
    expect(first.credentials._geminiServerPartsSessionId).toBeNull();
    expect(second.credentials._geminiServerPartsSessionId).toBeNull();
    const parts = second.out.contents.flatMap(c => c.parts);
    expect(parts.some(p => p.toolCall || p.toolResponse)).toBe(false);
    expect(parts.find(p => p.functionCall).functionCall.id).toBe("call_393372");
  });

  const historyWithCall = (tools) => ({
    model: MODEL,
    instructions: "You are a precise assistant.",
    tools,
    input: [
      userMessage(),
      { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
      { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Anything else?" }] },
    ],
  });

  it("strips replayed server parts when the target cannot serve web search", async () => {
    const credentials = session();
    await runStream([nativeResponse(probeParts)], credentials);
    const ag = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.ANTIGRAVITY, "gemini-3.8-flash-high", historyWithCall([recordVersion(), webSearch]), credentials, "antigravity");
    const agParts = ag.request.contents.flatMap(c => c.parts);
    expect(agParts.some(p => p.toolCall || p.toolResponse)).toBe(false);
    const fc = agParts.find(p => p.functionCall);
    expect(fc.functionCall).toEqual({ id: "call_393372", name: "record_version", args: { version: "24.21.0" } });
    expect(fc.thoughtSignature).toBe(CALL_SIG);
    expect(JSON.stringify(ag)).not.toContain("googleSearch");
    expect(JSON.stringify(ag)).not.toContain("includeServerSideToolInvocations");
    const noSearch = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, historyWithCall([recordVersion()]), credentials, "gemini");
    const geminiParts = noSearch.contents.flatMap(c => c.parts);
    expect(geminiParts.some(p => p.toolCall || p.toolResponse)).toBe(false);
    expect(JSON.stringify(noSearch)).not.toContain("googleSearch");
    expect(JSON.stringify(noSearch)).not.toContain("includeServerSideToolInvocations");
    const enabled = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, historyWithCall([recordVersion(), webSearch]), credentials, "gemini");
    const modelTurn = enabled.contents.find(c => c.role === "model");
    const fcIndex = modelTurn.parts.findIndex(p => p.functionCall);
    expect(modelTurn.parts.slice(0, fcIndex)).toEqual(serverParts);
  });

  it("captures and replays server parts through the non-streaming handler", () => {
    const credentials = session();
    const result = translateNonStreamingResponse(nativeResponse(probeParts), FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES, null, credentials._geminiTurnScope, credentials._clientSessionId, credentials._geminiServerPartsSessionId);
    const call = result.output.find(i => i.type === "function_call");
    expect(call).toMatchObject({ name: "record_version", call_id: "call_393372" });
    expect(getGeminiThoughtSignatureSync("call_393372", credentials._clientSessionId, MODEL)).toBe(CALL_SIG);
    const next = {
      model: MODEL,
      instructions: "You are a precise assistant.",
      tools: [recordVersion(), webSearch],
      input: [
        userMessage(),
        { type: "function_call", name: "record_version", call_id: "call_393372", arguments: '{"version":"24.21.0"}' },
        { type: "function_call_output", call_id: "call_393372", output: '{"ok":true}' },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Done?" }] },
      ],
    };
    const translated = translateForTenant(FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI, MODEL, next, credentials, "aistudio");
    const modelTurn = translated.contents.find(c => c.role === "model");
    const fcIndex = modelTurn.parts.findIndex(p => p.functionCall);
    expect(modelTurn.parts.slice(0, fcIndex)).toEqual(serverParts);
  });
});
