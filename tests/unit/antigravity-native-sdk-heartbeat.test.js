import { describe, expect, it } from "vitest";
import { unwrapAntigravityResponse } from "../../open-sse/utils/antigravityNative.js";

// Google GenAI SDK 2.28 _api_client.py:391-421 collects data lines and
// interprets every other nonempty line as a JSON/error response. An SSE
// comment therefore fails the real client even though SSE permits comments.
function sdkEvents(text) {
  const events = [], data = [];
  for (const line of text.split("\n")) {
    if (!line) {
      if (data.length) { events.push(JSON.parse(data.join("\n"))); data.length = 0; }
    } else if (line.startsWith("data: ")) data.push(line.slice(6));
    else throw new Error("SDK non-JSON response");
  }
  if (data.length) events.push(JSON.parse(data.join("\n")));
  return events;
}

describe("Antigravity native SDK heartbeat compatibility", () => {
  it("keeps activity visible before a complete event without a non-JSON SDK frame", async () => {
    let source;
    const input = new ReadableStream({ start(controller) { source = controller; } });
    const response = await unwrapAntigravityResponse(new Response(input, { headers: { "Content-Type": "text/event-stream" } }), true, { query: [["alt", "sse"]] });
    const reader = response.body.getReader();
    const pending = reader.read();
    source.enqueue(new TextEncoder().encode('data: {"response":'));
    const early = await pending;
    const earlyText = new TextDecoder().decode(early.value);
    expect(earlyText).toBe("\n");
    expect(sdkEvents(earlyText)).toEqual([]);
    source.enqueue(new TextEncoder().encode('{"candidates":[{"content":{"parts":[{"text":"готово"}]},"finishReason":"STOP"}]}}\n\n'));
    source.close();
    let text = earlyText;
    for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    expect(sdkEvents(text)).toEqual([{ candidates: [{ content: { parts: [{ text: "готово" }] }, finishReason: "STOP" }] }]);
    expect(text).not.toContain(":\n");
  });
});
