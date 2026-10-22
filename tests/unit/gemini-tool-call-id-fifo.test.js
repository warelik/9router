import { describe, expect, it } from "vitest";

import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

const MODEL = "gemini-3.8-flash";
const call = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const assistant = (...calls) => ({ role: "assistant", tool_calls: calls });
const result = (id, content) => ({ role: "tool", tool_call_id: id, content });

function convert(messages) {
  const body = { model: MODEL, messages };
  const before = JSON.stringify(body);
  const out = openaiToGeminiRequest(MODEL, body, false);
  expect(JSON.stringify(body)).toBe(before);
  const parts = out.contents.flatMap((c) => c.parts);
  return {
    out,
    calls: parts.filter((p) => p.functionCall).map((p) => p.functionCall),
    responses: parts.filter((p) => p.functionResponse).map((p) => p.functionResponse),
  };
}

describe("Gemini tool-call identity with repeated ids", () => {
  it("answers each repeated id with its own call id, name and result", () => {
    const { calls, responses } = convert([
      { role: "user", content: "go" },
      assistant(call("call_1", "read", { path: "a" })),
      result("call_1", '{"text":"first"}'),
      { role: "user", content: "again" },
      assistant(call("call_1", "write", { path: "b" })),
      result("call_1", '{"text":"second"}'),
    ]);
    expect(calls[0].id).toBe("call_1");
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(responses.map((r) => r.id)).toEqual(calls.map((c) => c.id));
    expect(responses.map((r) => r.name)).toEqual(["read", "write"]);
    expect(responses.map((r) => r.response)).toEqual([{ text: "first" }, { text: "second" }]);
  });

  it("matches results of duplicate sibling calls first-in first-out", () => {
    const { calls, responses } = convert([
      { role: "user", content: "go" },
      assistant(call("call_dup", "alpha"), call("call_dup", "beta")),
      result("call_dup", '{"v":1}'),
      result("call_dup", '{"v":2}'),
    ]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(responses.map((r) => [r.id, r.name, r.response])).toEqual([
      [calls[0].id, "alpha", { v: 1 }],
      [calls[1].id, "beta", { v: 2 }],
    ]);
  });

  it("does not invent a functionResponse when the result is missing", () => {
    const { calls, responses, out } = convert([
      { role: "user", content: "go" },
      assistant(call("call_missing", "read")),
      { role: "user", content: "never mind" },
    ]);
    expect(calls).toHaveLength(1);
    expect(responses).toHaveLength(0);
    expect(JSON.stringify(out.contents)).not.toContain("functionResponse");
  });

  it("leaves already unique ids unchanged", () => {
    const { calls, responses } = convert([
      { role: "user", content: "go" },
      assistant(call("call_a", "read"), call("call_b", "write")),
      result("call_a", '{"ok":true}'),
      result("call_b", '{"ok":false}'),
    ]);
    expect(calls.map((c) => c.id)).toEqual(["call_a", "call_b"]);
    expect(responses.map((r) => [r.id, r.name])).toEqual([["call_a", "read"], ["call_b", "write"]]);
  });

  it("keeps the private representation of array and JSON null results", () => {
    const { responses } = convert([
      { role: "user", content: "go" },
      assistant(call("call_arr", "list"), call("call_null", "nothing")),
      result("call_arr", "[1,2]"),
      result("call_null", "null"),
    ]);
    expect(responses[0].response).toEqual({ result: [1, 2] });
    expect(responses[1].response).toEqual({ result: null });
  });

  describe("reserved response keys", () => {
    const single = (content) => convert([
      { role: "user", content: "go" },
      assistant(call("call_ref", "fetch")),
      result("call_ref", content),
    ]);

    it("forwards a payload carrying both reserved and renamed keys without losing either", () => {
      const original = { $ref: "#/$defs/A", _ref: "separate", other: 1 };
      const { responses } = single(JSON.stringify(original));
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({ id: "call_ref", name: "fetch" });
      expect(JSON.parse(responses[0].response.result)).toEqual(original);
    });

    it("keeps reserved keys nested in objects and arrays", () => {
      const original = { items: [{ $ref: "#/$defs/B", _ref: "kept" }], nested: { deeper: { $ref: "x", _ref: "y" } } };
      const { responses } = single(JSON.stringify(original));
      expect(JSON.parse(responses[0].response.result)).toEqual(original);
    });

    it("does not rewrite plain text that only mentions the key", () => {
      const { responses } = single("see $ref in the schema");
      expect(responses[0].response).toEqual({ result: "see $ref in the schema" });
    });

    it("leaves ordinary payloads unchanged", () => {
      const { responses } = single('{"text":"fine","count":2}');
      expect(responses[0].response).toEqual({ text: "fine", count: 2 });
    });
  });
});
