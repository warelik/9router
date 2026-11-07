import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }),
}));

const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const GEMINI_CHUNKS = [
  { responseId: "r", candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }] },
  { responseId: "r", candidates: [{ content: { role: "model", parts: [{ text: " world" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } },
];

async function run(sourceFormat, { withDone = false, tailOnly = false } = {}) {
  const chunks = tailOnly ? [GEMINI_CHUNKS[1]] : GEMINI_CHUNKS;
  // tailOnly: a single EOF-terminated chunk without a trailing newline is parsed and emitted in flush().
  const body = tailOnly
    ? `data: ${JSON.stringify(chunks[0])}`
    : chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (withDone ? "data: [DONE]\n\n" : "");
  const input = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } });
  const out = input.pipeThrough(createSSETransformStreamWithLogger(FORMATS.GEMINI, sourceFormat, "gemini-wire-test", null, null, "model-x"));
  const reader = out.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += typeof value === "string" ? value : dec.decode(value, { stream: true });
  }
  return text;
}
const doneCount = (t) => t.split("\n").filter((l) => l.trim() === "data: [DONE]").length;

describe("translated stream for an OpenAI Chat client", () => {
  it("ends with exactly one [DONE] although the Gemini upstream sends none", async () => {
    const text = await run(FORMATS.OPENAI);
    expect(text).toContain("hello");
    expect(doneCount(text)).toBe(1);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("does not duplicate [DONE] when the upstream already sent one", async () => {
    expect(doneCount(await run(FORMATS.OPENAI, { withDone: true }))).toBe(1);
  });

  it("does not add the OpenAI sentinel to a Claude client stream", async () => {
    expect(doneCount(await run(FORMATS.CLAUDE))).toBe(0);
  });

  it("also terminates a stream whose only chunk is emitted while flushing", async () => {
    const text = await run(FORMATS.OPENAI, { tailOnly: true });
    expect(text).toContain("world");
    expect(doneCount(text)).toBe(1);
  });
});
