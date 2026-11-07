// Always-adaptive Claude models (thinkingCanDisable: false) keep the client's
// thinking.display. Dropping it sent the redact-thinking beta, so Anthropic
// returned signature-only thinking blocks even when the client asked for summaries.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { selectAnthropicBeta } from "../../open-sse/providers/shared.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const REDACT = "redact-thinking-2026-02-12";
const ALWAYS_ADAPTIVE = "claude-opus-5-5";
const CAN_DISABLE = "claude-sonnet-5-5";
const FABLE = "claude-fable-5-1";

function toClaude(model, sourceFormat, body) {
  return translateRequest(sourceFormat, FORMATS.CLAUDE, model, body, true, null, "claude", null, [], "x", "claude");
}

const claudeBody = thinking => ({
  model: ALWAYS_ADAPTIVE,
  max_tokens: 4096,
  messages: [{ role: "user", content: "hi" }],
  ...(thinking ? { thinking } : {})
});

describe("always-adaptive Claude models keep the client's thinking display", () => {
  it("forwards display summarized with effort and drops the redact beta", () => {
    const out = toClaude(ALWAYS_ADAPTIVE, FORMATS.CLAUDE, {
      ...claudeBody({ type: "adaptive", display: "summarized" }),
      output_config: { effort: "high" }
    });
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config.effort).toBe("high");
    expect(selectAnthropicBeta(ALWAYS_ADAPTIVE, out)).not.toContain(REDACT);
  });

  it("sends no thinking field and keeps the redact beta when no display was requested", () => {
    const out = toClaude(ALWAYS_ADAPTIVE, FORMATS.CLAUDE, claudeBody({ type: "adaptive" }));
    expect(out.thinking).toBeUndefined();
    expect(selectAnthropicBeta(ALWAYS_ADAPTIVE, out)).toContain(REDACT);
  });

  it("OpenAI reasoning_effort intent yields summarized thinking for always-adaptive models", () => {
    const out = toClaude(ALWAYS_ADAPTIVE, FORMATS.OPENAI, {
      model: ALWAYS_ADAPTIVE,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high"
    });
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(selectAnthropicBeta(ALWAYS_ADAPTIVE, out)).not.toContain(REDACT);
  });

  it("keeps display summarized on a model that can disable thinking", () => {
    const out = toClaude(CAN_DISABLE, FORMATS.CLAUDE, claudeBody({ type: "adaptive", display: "summarized" }));
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("sends no thinking field for Fable when no display was requested", () => {
    const out = toClaude(FABLE, FORMATS.CLAUDE, claudeBody({ type: "adaptive" }));
    expect(out.thinking).toBeUndefined();
  });

  it("leaves MiniMax Code's permanent-adaptive wire shape effort-only despite a display intent", () => {
    const body = { model: "MiniMax-M3.1-Flash-Preview", messages: [], thinking: { type: "adaptive", display: "summarized" } };
    applyThinking("claude", "MiniMax-M3.1-Flash-Preview(xhigh)", body, "minimax-code");
    expect(body.thinking).toBeUndefined();
    expect(body.output_config.effort).toBe("xhigh");
  });
});
