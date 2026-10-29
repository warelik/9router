/**
 * Muse Spark (Meta Model API) is served by the Responses API. A model that only
 * declares `supportedFormats: ["openai-responses"]` must still be reachable by an
 * OpenAI-format client: the transport must follow the translated body's wire
 * format, otherwise the Responses body (`input`) is POSTed to the default Chat
 * Completions URL and Meta rejects it with `unknown parameter `input``.
 *
 * Second half of the same bug: thinking for the Responses wire must be nested as
 * reasoning.effort, not the Chat-shaped top-level reasoning_effort (Meta rejects
 * `unknown parameter `reasoning_effort``).
 *
 * Repro model: muse/muse-spark-1.3-contributor(xhigh)
 * Ref: https://github.com/decolua/9router/pull/3757
 */
import { describe, expect, it } from "vitest";

import { getModelTargetFormat, getModelSupportedFormats, getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "../../open-sse/config/providerModels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

// Mirrors the transport selection in open-sse/handlers/chatCore.js so the
// invariant (body wire === endpoint wire) can be asserted without the full
// handler harness.
function selectTransport(provider, model, sourceFormat) {
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  const modelTargetTransport = modelTargetFormat ? resolveTransport(provider, modelTargetFormat) : null;
  const useTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat))
    ? runtimeTransport
    : modelTargetTransport;
  const targetFormat = useTransport?.format || modelTargetFormat || null;
  return { targetFormat, useTransport };
}

describe("Muse Responses wire routing", () => {
  it("routes an OpenAI client to the Responses transport, matching the translated body", () => {
    const { targetFormat, useTransport } = selectTransport("muse", "muse-spark-1.3-contributor(xhigh)", FORMATS.OPENAI);
    expect(targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
    expect(useTransport?.format).toBe(FORMATS.OPENAI_RESPONSES);
    expect(useTransport?.baseUrl).toBe("https://api.meta.ai/v1/responses");
  });

  it("keeps the upstream id after stripping only the thinking suffix", () => {
    expect(getModelTargetFormat("muse", "muse-spark-1.3-contributor(xhigh)")).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelSupportedFormats("muse", "muse-spark-1.3-contributor(xhigh)")).toEqual([FORMATS.OPENAI_RESPONSES]);
    expect(getModelUpstreamId("muse", "muse-spark-1.3-contributor(xhigh)")).toBe("muse-spark-1.3-contributor(xhigh)");
  });

  it("lets a native Responses client stay on the Responses transport", () => {
    const { targetFormat, useTransport } = selectTransport("muse", "muse-spark-1.3-contributor(xhigh)", FORMATS.OPENAI_RESPONSES);
    expect(targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
    expect(useTransport?.baseUrl).toBe("https://api.meta.ai/v1/responses");
  });
});

describe("Muse Wonder registry and documented capabilities", () => {
  it.each(["muse-wonder-1.0", "muse-wonder-1.0-contributor"])("routes %s through Responses", (model) => {
    const { targetFormat, useTransport } = selectTransport("muse", model, FORMATS.OPENAI);
    expect(targetFormat).toBe(FORMATS.OPENAI_RESPONSES);
    expect(useTransport?.baseUrl).toBe("https://api.meta.ai/v1/responses");
    expect(getModelSupportedFormats("muse", model)).toEqual([FORMATS.OPENAI_RESPONSES]);
  });

  it.each(["muse-wonder-1.0", "muse-wonder-1.0-contributor"])("publishes the Meta/models.dev parameters for %s", (model) => {
    expect(getCapabilitiesForModel("muse", model)).toMatchObject({
      vision: true,
      pdf: true,
      audioInput: true,
      videoInput: true,
      search: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: false,
      contextWindow: 1048576,
      maxOutput: 131072,
    });
    expect(getThinkingLevels("muse", model)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps Wonder max and clamps unsupported none to minimal", () => {
    const maxBody = { input: [] };
    applyThinking(FORMATS.OPENAI_RESPONSES, "muse-wonder-1.0", maxBody, "muse", { mode: "level", level: "max" });
    expect(maxBody.reasoning).toEqual({ effort: "max", summary: "auto" });

    const noneBody = { input: [] };
    applyThinking(FORMATS.OPENAI_RESPONSES, "muse-wonder-1.0-contributor", noneBody, "muse", { mode: "none" });
    expect(noneBody.reasoning).toEqual({ effort: "minimal", summary: "auto" });
  });
});

describe("Muse Responses thinking wire shape", () => {
  it("writes reasoning.effort (not top-level reasoning_effort) for the Responses wire", () => {
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    applyThinking(FORMATS.OPENAI_RESPONSES, "muse-spark-1.3-contributor(xhigh)", body, "muse", { mode: "level", level: "xhigh" });
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("clamps max to xhigh for the Responses wire", () => {
    const body = { input: [] };
    applyThinking(FORMATS.OPENAI_RESPONSES, "muse-spark-1.3", body, "muse", { mode: "level", level: "max" });
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("keeps Chat Completions clients on the Chat wire (top-level reasoning_effort)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    applyThinking(FORMATS.OPENAI, "muse-spark-1.3", body, "muse", { mode: "level", level: "high" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
  });
});
