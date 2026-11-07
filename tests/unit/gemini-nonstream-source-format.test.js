import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }),
}));

const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { getGeminiThoughtSignatureSync } = await import("../../open-sse/services/thoughtSignatureStore.js");

const geminiBody = () => ({
  responseId: "r1",
  modelVersion: "model-x",
  candidates: [{
    finishReason: "STOP",
    content: { role: "model", parts: [{ text: "thinking summary", thought: true }, { text: "final answer" }] },
  }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
});

describe("non-streaming Gemini upstream answers in the client's own format", () => {
  it("OpenAI client keeps the chat.completion shape", () => {
    const r = translateNonStreamingResponse(geminiBody(), FORMATS.GEMINI, FORMATS.OPENAI);
    expect(r.object).toBe("chat.completion");
    expect(r.choices[0].message.content).toBe("final answer");
    expect(r.choices[0].message.reasoning_content).toBe("thinking summary");
  });

  it("Claude client gets a message with thinking and text blocks", () => {
    const r = translateNonStreamingResponse(geminiBody(), FORMATS.GEMINI, FORMATS.CLAUDE);
    expect(r.type).toBe("message");
    expect(r.content.map((b) => b.type)).toEqual(expect.arrayContaining(["text"]));
    expect(r.content.find((b) => b.type === "text").text).toBe("final answer");
  });

  it("Responses client gets a response object with message output", () => {
    const r = translateNonStreamingResponse(geminiBody(), FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES);
    expect(r.object).toBe("response");
    const msg = r.output.find((o) => o.type === "message");
    expect(msg.content[0].text).toBe("final answer");
  });

  it("reports a MAX_TOKENS cut-off as a valid terminal state for every client format", () => {
    const cut = () => ({ ...geminiBody(), candidates: [{ ...geminiBody().candidates[0], finishReason: "MAX_TOKENS" }] });
    expect(translateNonStreamingResponse(cut(), FORMATS.GEMINI, FORMATS.OPENAI).choices[0].finish_reason).toBe("length");
    const resp = translateNonStreamingResponse(cut(), FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES);
    expect(resp.status).toBe("incomplete");
    expect(resp.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(translateNonStreamingResponse(cut(), FORMATS.GEMINI, FORMATS.CLAUDE).stop_reason).toBe("max_tokens");
  });

  it("caches the signature of a returned tool call under the id the client will send back", () => {
    const body = {
      responseId: "r2",
      candidates: [{
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: "plan", thought: true }, { functionCall: { name: "lookup", args: { q: 1 } }, thoughtSignature: "call-sig-1" }] },
      }],
    };
    const r = translateNonStreamingResponse(body, FORMATS.GEMINI, FORMATS.CLAUDE, null, null, null);
    const toolUse = r.content.find((b) => b.type === "tool_use");
    expect(toolUse.id).toBeTruthy();
    expect(getGeminiThoughtSignatureSync(toolUse.id, null, "gemini-model")).toBe("call-sig-1");
  });
});
