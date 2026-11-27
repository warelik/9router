import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { isValidClaudeSignature } from "../../open-sse/utils/claudeSignature.js";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

// Another provider behind an Anthropic-format combo (kimi-for-coding) signs
// its thinking with opaque bytes that only look random. Some of them start
// with 0x12, the leading byte of a Claude signature; Anthropic rejects such a
// block ("Invalid `signature` in `thinking` block") on every retry.
function opaqueSignature(seed, length, firstByte) {
  const chunks = [];
  for (let i = 0; Buffer.concat(chunks).length < length; i++) {
    chunks.push(createHash("sha256").update(`${seed}:${i}`).digest());
  }
  const bytes = Buffer.concat(chunks).subarray(0, length);
  bytes[0] = firstByte;
  return bytes.toString("base64");
}

const b64 = bytes => Buffer.from(bytes).toString("base64");
// Shape of a real Claude 5.5 signature: version varint, then field 2 holding
// a nested message, every byte accounted for.
const claudeLike = b64([0x08, 0x04, 0x12, 0x0a, 0x0a, 0x02, 0x08, 0x13, 0x42, 0x04, 0x74, 0x68, 0x69, 0x6e]);
const foreignE = opaqueSignature("kimi-e", 3255, 0x12);
const foreignC = opaqueSignature("kimi-c", 3255, 0x08);

const historyWith = signature => ({
  model: "claude-sonnet-5-5",
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

describe("foreign opaque signatures with a Claude-looking first byte", () => {
  it("still accepts a complete Claude-shaped signature", () => {
    expect(isValidClaudeSignature(claudeLike)).toBe(true);
    expect(isValidClaudeSignature(Buffer.from(claudeLike).toString("base64"))).toBe(true);
  });

  it.each([
    ["first byte 0x12", foreignE],
    ["first byte 0x08", foreignC],
    ["double-wrapped", Buffer.from(foreignE).toString("base64")],
    ["truncated Claude signature", b64([0x08, 0x04, 0x12, 0x0a, 0x0a, 0x02])],
    ["Claude signature with trailing bytes", b64([0x08, 0x04, 0x12, 0x01, 0x00, 0xff])],
  ])("rejects %s", (_name, signature) => {
    expect(isValidClaudeSignature(signature)).toBe(false);
  });

  it("never forwards the foreign block to Anthropic", () => {
    const normalized = historyWith(foreignE);
    normalizeClaudePassthrough(normalized, "claude-sonnet-5-5");
    const prepared = prepareClaudeRequest(historyWith(foreignE), "claude", "sk-ant-api-test");
    for (const body of [normalized, prepared]) {
      const content = body.messages[1].content;
      expect(content.some(block => block.signature === foreignE)).toBe(false);
      expect(content.at(-1)).toMatchObject({ type: "tool_use", id: "toolu_1" });
    }
  });
});
