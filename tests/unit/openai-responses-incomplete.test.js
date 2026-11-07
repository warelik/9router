import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function run(chunks, format, provider) {
  const input = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(input)); controller.close(); } });
  const output = await new Response(stream.pipeThrough(createSSETransformStreamWithLogger(format, FORMATS.OPENAI_RESPONSES, provider, null, null, "gemini-3.8-flash"))).text();
  return output.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
}

const targets = [
  [FORMATS.GEMINI, "gemini"],
  [FORMATS.GEMINI, "aistudio"],
  [FORMATS.ANTIGRAVITY, "antigravity"],
];
const usageMetadata = { promptTokenCount: 90, candidatesTokenCount: 10, thoughtsTokenCount: 10, cachedContentTokenCount: 40, totalTokenCount: 110 };
const expectedUsage = { input_tokens: 90, output_tokens: 20, total_tokens: 110, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 } };

for (const [format, provider] of targets) {
  describe(`${provider} to Responses terminal truth`, () => {
    for (const [finishReason, expectedReason] of [["MAX_TOKENS", "max_output_tokens"], ["SAFETY", "content_filter"]]) {
      for (const text of ["", "частичный ответ"]) {
        it(`${finishReason} with ${text ? "partial text" : "empty text"} is incomplete`, async () => {
          const response = { candidates: [{ content: { parts: text ? [{ text }] : [] }, finishReason }], usageMetadata };
          const events = await run([format === FORMATS.ANTIGRAVITY ? { response } : response], format, provider);
          const terminals = events.filter(event => ["response.completed", "response.incomplete", "response.failed"].includes(event.type));
          expect(terminals).toHaveLength(1);
          expect(terminals[0]).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: expectedReason }, error: null, usage: expectedUsage } });
          expect(events.some(event => event.type === "response.completed")).toBe(false);
        });
      }
    }
    it("STOP still completes and retains usage", async () => {
      const response = { candidates: [{ content: { parts: [{ text: "полный ответ" }] }, finishReason: "STOP" }], usageMetadata };
      const events = await run([format === FORMATS.ANTIGRAVITY ? { response } : response], format, provider);
      const terminals = events.filter(event => ["response.completed", "response.incomplete", "response.failed"].includes(event.type));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ type: "response.completed", response: { status: "completed", usage: expectedUsage } });
      expect(terminals[0].response.incomplete_details).toBeUndefined();
    });
  });
}

it("direct OpenAI length retains its reason through a late usage trailer", async () => {
  const events = await run([
    { id: "fixture", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
    { id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    { choices: [], usage: { prompt_tokens: 90, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } } },
  ], FORMATS.OPENAI, "openai");
  const terminals = events.filter(event => ["response.completed", "response.incomplete", "response.failed"].includes(event.type));
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toMatchObject({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: expectedUsage } });
});

it("native Responses incomplete is terminal without an added disconnect failure", async () => {
  const events = await run([{ type: "response.incomplete", response: { id: "fixture", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: expectedUsage } }], FORMATS.OPENAI_RESPONSES, "codex");
  expect(events.filter(event => event.type === "response.incomplete")).toHaveLength(1);
  expect(events.some(event => event.type === "response.failed")).toBe(false);
});

it("terminal guard recognizes incomplete event and status fallback", async () => {
  const { isOpenAIResponsesTerminalEvent } = await import("../../open-sse/utils/responsesStreamHelpers.js");
  expect(isOpenAIResponsesTerminalEvent("response.incomplete", {})).toBe(true);
  expect(isOpenAIResponsesTerminalEvent(null, { response: { status: "incomplete" } })).toBe(true);
  expect(isOpenAIResponsesTerminalEvent(null, { response: { status: "in_progress" } })).toBe(false);
});
