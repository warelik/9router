import { describe, it, expect } from "vitest";
import { MODEL_PRICING, getPricingForModel, calculateCostFromTokens } from "../../open-sse/providers/pricing.js";

describe("Muse Wonder pricing", () => {
  it("includes muse-wonder-1.0 and the full contributor variant", () => {
    expect(MODEL_PRICING["muse-wonder-1.0"]).toBeDefined();
    expect(MODEL_PRICING["muse-wonder-full-1.0-contributor"]).toBeDefined();
  });

  it("uses the published wonder rates (input 4.00, output 20.00, cached 0.20)", () => {
    expect(MODEL_PRICING["muse-wonder-1.0"]).toMatchObject({ input: 4.00, output: 20.00, cached: 0.20 });
    expect(MODEL_PRICING["muse-wonder-full-1.0-contributor"]).toMatchObject({ input: 4.00, output: 20.00, cached: 0.20 });
  });

  it("resolves pricing for the live muse surface ids", () => {
    expect(getPricingForModel("muse", "muse-wonder-full-1.0-contributor")).not.toBeNull();
    expect(getPricingForModel("openrouter", "meta/muse-wonder-1.0")).not.toBeNull();
  });

  it("charges cached input at the cached rate, not the full input rate", () => {
    const pricing = MODEL_PRICING["muse-wonder-full-1.0-contributor"];
    const cost = calculateCostFromTokens(
      { input_tokens: 1_000_000, cached_tokens: 990_000, output_tokens: 10_000 },
      pricing,
    );
    // 10k fresh * 4/M + 990k cached * 0.20/M + 10k out * 20/M
    expect(cost).toBeCloseTo(0.04 + 0.198 + 0.20, 6);
  });
});
