import { describe, expect, it } from "vitest";
import { kiroToOpenAIResponse } from "../../open-sse/translator/response/kiro-to-openai.js";
import { kiroToClaudeResponse, kiroToClaudeNonStreaming } from "../../open-sse/translator/response/kiro-to-claude.js";

const wire = "alpha_read";
const descriptorMap = () => new Map([[wire, { name: "read", namespace: "alpha", type: "function" }]]);
const normalizedChunk = (name, delta = {}, finish = null) => ({
  id: "chatcmpl-kiro", object: "chat.completion.chunk", created: 1, model: "kiro",
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_kiro", type: "function", function: { name, arguments: '{"title":"x"}' } }], ...delta }, finish_reason: finish }],
});

describe("Kiro response adapters keep descriptor maps off the wire name", () => {
  it("raw toolUseEvent yields the string wire alias", () => {
    const out = kiroToOpenAIResponse({ toolUseEvent: { toolUseId: "call_kiro", name: wire, input: { title: "x" } } }, { toolNameMap: descriptorMap() });
    const call = out.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe(wire);
    expect(call).toMatchObject({ id: "call_kiro" });
    expect(call.function.arguments).toBe('{"title":"x"}');
  });

  it("executor-normalized chunk yields the string wire alias", () => {
    const out = kiroToOpenAIResponse(normalizedChunk(wire), { toolNameMap: descriptorMap() });
    expect(out.choices[0].delta.tool_calls[0].function.name).toBe(wire);
  });

  it("Kiro to Claude streaming and non-streaming yield the string wire alias", () => {
    const state = { toolNameMap: descriptorMap(), nextBlockIndex: 0 };
    const events = kiroToClaudeResponse(normalizedChunk(wire), state);
    const start = events.find(e => e.type === "content_block_start");
    expect(start.content_block.name).toBe(wire);
    expect(start.content_block.id).toBe("call_kiro");
    const message = kiroToClaudeNonStreaming({ _toolNameMap: descriptorMap(), choices: [{ message: { tool_calls: [{ id: "call_kiro", function: { name: wire, arguments: '{"title":"x"}' } }] }, finish_reason: "tool_calls" }] });
    expect(message.content[0]).toMatchObject({ type: "tool_use", id: "call_kiro", name: wire, input: { title: "x" } });
  });

  it("plain string map entries still restore the original tool name", () => {
    const out = kiroToOpenAIResponse(normalizedChunk("wire_plain"), { toolNameMap: new Map([["wire_plain", "original_tool"]]) });
    expect(out.choices[0].delta.tool_calls[0].function.name).toBe("original_tool");
  });
});
