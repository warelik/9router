import { describe, it, expect } from "vitest";

import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";

// "aistudio" is the local AIStudioToAPI bridge spoken to on its Gemini-native /v1beta surface:
// only that surface carries the real thoughtSignature. The bridge decides which models exist, so
// nothing here names a model: the id below is an arbitrary string the bridge could serve.
const MODEL = "model-served-by-the-bridge";
const EXPECT_PLAIN_HEADERS = { "Content-Type": "application/json", "x-goog-api-key": "bridge-key" };
const EXPECT_SSE_HEADERS = { ...EXPECT_PLAIN_HEADERS, Accept: "text/event-stream" };

describe("aistudio provider (Gemini wire to the local bridge)", () => {
  const cfg = PROVIDERS.aistudio;

  it("is registered and speaks the Gemini wire", () => {
    expect(cfg).toBeTruthy();
    expect(cfg.format).toBe("gemini");
    expect(getTargetFormat("aistudio", {})).toBe("gemini");
  });

  it("locks the full non-streaming and streaming URLs (exact origin, no query beyond alt=sse)", () => {
    const ex = new DefaultExecutor("aistudio");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:7860/v1beta/models");
    expect(ex.buildUrl(MODEL, false, 0, {})).toBe(`http://127.0.0.1:7860/v1beta/models/${MODEL}:generateContent`);
    expect(ex.buildUrl(MODEL, true, 0, {})).toBe(`http://127.0.0.1:7860/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`);
  });

  it("locks the complete header set for both modes (x-goog-api-key, no Authorization)", () => {
    const ex = new DefaultExecutor("aistudio");
    const plain = ex.buildHeaders({ apiKey: "bridge-key" }, false, ex.buildUrl(MODEL, false, 0, {}), MODEL);
    const sse = ex.buildHeaders({ apiKey: "bridge-key" }, true, ex.buildUrl(MODEL, true, 0, {}), MODEL);
    expect(plain).toEqual(EXPECT_PLAIN_HEADERS);
    expect(sse).toEqual(EXPECT_SSE_HEADERS);
  });

  it("forwards any model id the bridge serves without a registry list", async () => {
    expect(cfg.passthroughModels ?? true).toBeTruthy();
    const info = await getModelInfoCore(`aistudio/${MODEL}`, {});
    expect(info.provider).toBe("aistudio");
    expect(info.model).toBe(MODEL);
  });

  it("carries no Google OAuth client material of its own", () => {
    expect(cfg.clientId).toBeUndefined();
    expect(cfg.clientSecret).toBeUndefined();
  });
});
