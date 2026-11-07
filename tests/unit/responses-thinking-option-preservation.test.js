import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const FORMAT = "openai-responses";
const MODEL = "muse-spark-1.3-contributor";
const preserve = { preserveResponsesOptions: true };

describe("applyThinking preserveResponsesOptions", () => {
  it("keeps native summary and opaque reasoning, include and metadata fields", () => {
    const body = {
      reasoning: { effort: "xhigh", summary: "none", vendor: { tier: 2 }, context: "keep" },
      include: ["reasoning.encrypted_content"],
      metadata: { run: "r1" },
    };
    applyThinking(FORMAT, MODEL, body, "muse", undefined, preserve);
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "none", vendor: { tier: 2 }, context: "keep" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.metadata).toEqual({ run: "r1" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it.each(["none", "off", "max", "future-level"])("migrates top-level %s unchanged without a summary", (effort) => {
    const body = { reasoning_effort: effort };
    applyThinking(FORMAT, MODEL, body, "muse", undefined, preserve);
    expect(body.reasoning).toEqual({ effort });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("does not invent a summary for a provider-level intent", () => {
    const body = {};
    applyThinking(FORMAT, MODEL, body, "muse", { mode: "level", level: "xhigh" }, preserve);
    expect(body.reasoning).toEqual({ effort: "xhigh" });
  });

  it("lets a model suffix override an explicit effort", () => {
    const body = { reasoning: { effort: "low", summary: "none" } };
    applyThinking(FORMAT, `${MODEL}(high)`, body, "muse", undefined, preserve);
    expect(body.reasoning).toEqual({ effort: "high", summary: "none" });
  });

  it("keeps the upstream standalone behavior when the option is off", () => {
    const body = { reasoning_effort: "xhigh" };
    applyThinking(FORMAT, MODEL, body, "muse");
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("translateRequest OpenAI to Responses keeps client reasoning options", () => {
  const translate = (extra) => {
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }], ...extra };
    const before = JSON.stringify(body);
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, MODEL, body, true, {}, "muse");
    expect(JSON.stringify(body)).toBe(before);
    return out;
  };

  it("retains the client's summary and opaque reasoning keys next to the effort", () => {
    const out = translate({ reasoning_effort: "medium", reasoning: { summary: "detailed", vendor: "keep" } });
    expect(out.reasoning).toEqual({ summary: "detailed", vendor: "keep", effort: "medium" });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("sends a plain effort without an invented summary", () => {
    const out = translate({ reasoning_effort: "xhigh" });
    expect(out.reasoning).toEqual({ effort: "xhigh" });
  });
});
