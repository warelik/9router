import { describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    get: async () => null,
    set: async () => {},
    remove: async () => {},
    getAll: async () => ({}),
  }),
}));

const { normalizeResponsesAgentMessage, convertResponsesApiFormat } = await import("../../open-sse/translator/formats/responsesApi.js");
const { openaiResponsesToOpenAIRequest } = await import("../../open-sse/translator/request/openai-responses.js");
const { restoreToolNames } = await import("../../open-sse/utils/opencodeFingerprint.js");
const { hasUndeliverableAgentMessage } = await import("../../open-sse/translator/concerns/portableCollaboration.js");
const { openaiToGeminiRequest } = await import("../../open-sse/translator/request/openai-to-gemini.js");
const { storeGeminiTurnSignature, storeGeminiServerPartsForTurn } = await import("../../open-sse/services/thoughtSignatureStore.js");

describe("readable agent messages cross both Chat bridges without Fernet blocks", () => {
  it.each([
    ["format bridge", (body) => convertResponsesApiFormat(body)],
    ["request bridge", (body) => openaiResponsesToOpenAIRequest("m", body, true, {})],
  ])("keeps exact readable content and caller bytes in the %s", (_label, bridge) => {
    const item = {
      type: "agent_message",
      content: [
        { type: "input_text", text: "Readable task\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAA-opaque-token" },
        { type: "encrypted_content", encrypted_content: "plaintext task carrier  " },
      ],
    };
    const body = { model: "m", input: [item] };
    const before = JSON.stringify(body);
    expect(hasUndeliverableAgentMessage(body.input)).toBe(false);
    expect(bridge(body).messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Readable task\n" },
        { type: "text", text: "plaintext task carrier  " },
      ],
    }]);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("preserves opaque-only detection and the default normalization contract", () => {
    const opaque = {
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: "gAAAAA-opaque-token" }],
    };
    expect(hasUndeliverableAgentMessage([opaque])).toBe(true);
    expect(normalizeResponsesAgentMessage(opaque).content).toEqual(opaque.content);
  });
});

describe("Gemini historical turns retain their own instruction prefix", () => {
  it.each([
    ["system", "later system rule"],
    ["developer", [{ type: "text", text: "later developer rule" }]],
  ])("replays signatures and search parts after a later %s instruction", (role, lateContent) => {
    const model = "gemini-downstream-history-regression";
    const sessionId = `history-prefix-${role}`;
    const initial = [
      { role: "system", content: "original rule" },
      { role: "user", content: `question-${role}` },
    ];
    const credentials = { _geminiServerPartsSessionId: sessionId };
    openaiToGeminiRequest(model, { messages: initial }, true, credentials);
    const reasoning = `earlier reasoning-${role}`;
    const content = `earlier answer-${role}`;
    const signature = `exact-turn-signature-${role}`;
    const turn = { reasoning, content, scope: credentials._geminiTurnScope, sessionId };
    const searchPart = {
      thoughtSignature: `exact-search-signature-${role}`,
      toolCall: { id: `search-${role}`, toolType: "GOOGLE_SEARCH_WEB", args: { queries: [role] } },
    };
    storeGeminiTurnSignature(turn, signature, model);
    storeGeminiServerPartsForTurn({ ...turn, sessionId }, [searchPart], model);

    const body = { messages: [
      ...initial,
      { role: "assistant", reasoning_content: reasoning, content },
      { role, content: lateContent },
      { role: "user", content: "continue with the new instruction" },
    ] };
    const before = JSON.stringify(body);
    const out = openaiToGeminiRequest(model, body, false, credentials);
    const parts = out.contents.filter((entry) => entry.role === "model").flatMap((entry) => entry.parts);
    expect(parts).toContainEqual({ text: content, thoughtSignature: signature });
    expect(parts).toContainEqual(searchPart);
    expect(out.systemInstruction.parts).toEqual([
      { text: "original rule" },
      { text: role === "system" ? lateContent : lateContent[0].text },
    ]);
    expect(JSON.stringify(body)).toBe(before);

    const unrelated = structuredClone(body);
    unrelated.messages[0].content = "different original rule";
    const isolated = openaiToGeminiRequest(model, unrelated, false, credentials);
    const isolatedParts = isolated.contents.filter((entry) => entry.role === "model").flatMap((entry) => entry.parts);
    expect(isolatedParts.some((part) => part.thoughtSignature === signature)).toBe(false);
    expect(isolatedParts).not.toContainEqual(searchPart);
  });
});

describe("forced Responses custom tool choices preserve custom identity", () => {
  const format = { type: "grammar", syntax: "lark", definition: "start: TEXT" };

  it("uses the declaration alias and keeps its custom descriptor for successful calls", () => {
    const body = {
      model: "m",
      tools: [{ type: "namespace", name: "automation", tools: [
        { type: "custom", name: "patch", description: "Apply raw input.", format },
      ] }],
      input: [],
      tool_choice: { type: "custom", name: "patch", namespace: "automation" },
    };
    const out = openaiResponsesToOpenAIRequest(body.model, body, true, {});
    const [wireName, descriptor] = [...out._toolNameMap].find(([, value]) =>
      value?.name === "patch" && value.namespace === "automation");

    expect(wireName).toBeTruthy();
    expect(descriptor).toEqual({
      name: "patch", namespace: "automation", type: "custom", format,
    });
    expect(out.tool_choice).toEqual({ type: "function", function: { name: wireName } });
    expect(out._customToolNames).toContain(wireName);
    expect(restoreToolNames({
      type: "function_call", name: wireName, call_id: "call_patch", arguments: "RAW_PATCH",
    }, out._toolNameMap)).toEqual({
      type: "custom_tool_call", name: "patch", namespace: "automation",
      call_id: "call_patch", input: "RAW_PATCH",
    });
    const refusal = {
      output: [{ type: "message", role: "assistant", content: [
        { type: "refusal", refusal: "I can't help with that request." },
      ] }],
    };
    expect(restoreToolNames(refusal, out._toolNameMap)).toEqual(refusal);
  });

  it("normalizes a root custom choice and leaves refusal output untouched", () => {
    const body = {
      model: "m",
      tools: [{ type: "custom", name: "apply_patch", format }],
      input: [],
      tool_choice: { type: "custom", name: "apply_patch" },
    };
    const out = openaiResponsesToOpenAIRequest(body.model, body, true, {});
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "apply_patch" } });
    expect(out._customToolNames).toContain("apply_patch");
  });
});
