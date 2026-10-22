import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

// Chat -> Responses stream: every output item (reasoning, message, each tool call) must get
// its own output_index, and response.completed.output must keep all of them in emission order.
// Regression: reasoning, the message and the first tool call all used index 0, so clients saw a
// repeated output_item.done index and the reasoning item was overwritten in completed.output.
function run(chunks) {
  const state = { ...initState(FORMATS.OPENAI_RESPONSES), targetFormat: FORMATS.OPENAI };
  const events = [];
  for (const chunk of chunks) events.push(...openaiToOpenAIResponsesResponse(chunk, state));
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  return events;
}

const chunk = (delta, finish_reason) => ({ id: "chatcmpl-1", choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }] });
const reasoning = (text) => chunk({ reasoning_content: text });
const text = (t) => chunk({ content: t });
const call = (index, id, name, args) => chunk({ tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] });
const finish = (reason = "stop") => ({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 5, completion_tokens: 5 } });

const byEvent = (events, name) => events.filter((e) => e.event === name);
const completed = (events) => byEvent(events, "response.completed")[0].data.response;

function expectConsistentIndices(events) {
  const added = byEvent(events, "response.output_item.added").map((e) => ({ index: e.data.output_index, id: e.data.item.id }));
  const done = byEvent(events, "response.output_item.done").map((e) => ({ index: e.data.output_index, id: e.data.item.id }));
  expect(new Set(added.map((a) => a.index)).size, "output_item.added indices must be unique").toBe(added.length);
  expect(new Set(done.map((d) => d.index)).size, "output_item.done indices must be unique").toBe(done.length);
  for (const item of added) {
    expect(done.find((d) => d.id === item.id)?.index, `done index of ${item.id}`).toBe(item.index);
  }
  // Every event that names an item must use the index that item was added with.
  const indexOf = new Map(added.map((a) => [a.id, a.index]));
  for (const e of events) {
    if (e.data?.item_id && e.data.output_index !== undefined) {
      expect(e.data.output_index, `${e.event} for ${e.data.item_id}`).toBe(indexOf.get(e.data.item_id));
    }
  }
  expect(added.map((a) => a.index)).toEqual(added.map((_, i) => i));
  return added;
}

describe("Responses output_index allocation", () => {
  it("gives reasoning and the following message different indices and keeps both in completed.output", () => {
    const events = run([reasoning("think"), text("answer"), finish()]);
    const added = expectConsistentIndices(events);
    expect(added).toHaveLength(2);
    expect(completed(events).output.map((o) => o.type)).toEqual(["reasoning", "message"]);
  });

  it("gives reasoning and the first tool call different indices", () => {
    const events = run([reasoning("think"), call(0, "call_a", "lookup", "{\"q\":1}"), finish("tool_calls")]);
    expectConsistentIndices(events);
    expect(completed(events).output.map((o) => o.type)).toEqual(["reasoning", "function_call"]);
  });

  it("orders reasoning, message and parallel tool calls by first appearance", () => {
    const events = run([
      reasoning("think"), text("let me check"),
      call(0, "call_a", "lookup", "{}"), call(1, "call_b", "lookup", "{}"),
      finish("tool_calls"),
    ]);
    expectConsistentIndices(events);
    expect(completed(events).output.map((o) => o.type)).toEqual(["reasoning", "message", "function_call", "function_call"]);
    expect(completed(events).output.filter((o) => o.type === "function_call").map((o) => o.call_id)).toEqual(["call_a", "call_b"]);
  });

  it("keeps the old indices for the cases that never collided", () => {
    const textOnly = run([text("a"), finish()]);
    expect(byEvent(textOnly, "response.output_item.added")[0].data.output_index).toBe(0);
    const calls = run([call(0, "call_a", "f", "{}"), call(1, "call_b", "f", "{}"), finish("tool_calls")]);
    expect(byEvent(calls, "response.output_item.added").map((e) => e.data.output_index)).toEqual([0, 1]);
  });
});
