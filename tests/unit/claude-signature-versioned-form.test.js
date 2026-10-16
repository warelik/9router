import { describe, it, expect } from "vitest";
import { isValidClaudeSignature } from "../../open-sse/utils/claudeSignature.js";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const b64 = bytes => Buffer.from(bytes).toString("base64");

const cForm = b64([0x08, 0x04, 0x12, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]);
const cFormMultiByteVarint = b64([0x08, 0x80, 0x01, 0x12, 0x01, 0x00]);
const eForm = b64([0x12, 0x03, 0x01, 0x02, 0x03]);
const rForm = Buffer.from(eForm).toString("base64");
const qForm = Buffer.from(cForm).toString("base64");
const foreignMarker = b64([0x0a, 0x10, 0x01, 0x02]);
const foreignVarint = b64([0x08, 0x04, 0x0a, 0x01]);
const foreignWrapped = Buffer.from(foreignMarker).toString("base64");

describe("isValidClaudeSignature accepts every Claude signature form", () => {
  it.each([
    ["C-form with a version varint", cForm],
    ["C-form with a multi-byte version varint", cFormMultiByteVarint],
    ["E-form", eForm],
    ["R-form wrapping an E-form", rForm],
    ["Q-form wrapping a C-form", qForm]
  ])("accepts %s", (_, signature) => {
    expect(isValidClaudeSignature(signature)).toBe(true);
  });

  it.each([
    ["marker byte absent", foreignMarker],
    ["marker byte absent after a version varint", foreignVarint],
    ["double-wrapped foreign payload", foreignWrapped],
    ["empty string", ""]
  ])("rejects %s", (_, signature) => {
    expect(isValidClaudeSignature(signature)).toBe(false);
  });

  it("returns a boolean for non-base64 garbage without throwing", () => {
    expect(typeof isValidClaudeSignature("CAQS!!@@$$%%")).toBe("boolean");
  });
});

const historyWith = signature => ({
  model: "claude-opus-5-5",
  thinking: { type: "enabled", budget_tokens: 1024 },
  messages: [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t", signature },
        { type: "tool_use", id: "toolu_1", name: "read", input: {} }
      ]
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }
  ]
});

const assistantContent = body => body.messages[1].content;
const isPlaceholder = block => block.type === "thinking" && block.thinking === ".";

describe("claude passthrough keeps versioned signatures in history", () => {
  it("keeps a C-form thinking block and adds no placeholder (normalizeClaudePassthrough)", () => {
    const body = historyWith(cForm);
    normalizeClaudePassthrough(body, "claude-opus-5-5");

    const content = assistantContent(body);
    expect(content[0]).toEqual({ type: "thinking", thinking: "t", signature: cForm });
    expect(content.some(isPlaceholder)).toBe(false);
  });

  it("keeps a C-form thinking block for provider claude (prepareClaudeRequest)", () => {
    const body = prepareClaudeRequest(historyWith(cForm), "claude", "sk-ant-api-test");

    const content = assistantContent(body);
    expect(content.find(block => block.type === "thinking")).toMatchObject({ thinking: "t", signature: cForm });
    expect(content.some(isPlaceholder)).toBe(false);
  });

  it("still drops a foreign-signed thinking block and inserts the placeholder", () => {
    const body = historyWith(foreignMarker);
    normalizeClaudePassthrough(body, "claude-opus-5-5");

    const content = assistantContent(body);
    expect(content.some(block => block.signature === foreignMarker)).toBe(false);
    expect(content[0]).toMatchObject({ type: "thinking", thinking: "." });
    expect(content.at(-1)).toMatchObject({ type: "tool_use", id: "toolu_1" });
  });
});
