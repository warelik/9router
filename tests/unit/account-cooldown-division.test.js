// Regression for the 429/503 cooldown division (RATE_LIMIT_COOLDOWN_DIVISOR = 3).
// Only cooldowns caused by 429 and 503 are divided. Other statuses keep their
// configured duration, and provider-reported reset timestamps are never divided.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { RATE_LIMIT_COOLDOWN_DIVISOR, COOLDOWN_MS, TRANSIENT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

describe("RATE_LIMIT_COOLDOWN_DIVISOR scales only 429 and 503", () => {
  it("the divisor is 3", () => {
    expect(RATE_LIMIT_COOLDOWN_DIVISOR).toBe(3);
  });

  it("a 503 with the short cooldown is divided by 3", () => {
    const r = checkFallbackError(503, "upstream unavailable", 0, "p");
    // COOLDOWN.short is 5000 ms for 503; the divisor brings it to round(5000 / 3).
    expect(r.cooldownMs).toBe(Math.round(5000 / RATE_LIMIT_COOLDOWN_DIVISOR));
  });

  it("a 429 backoff level is divided by 3", () => {
    // Backoff level 1 gives the base 2000 ms (getQuotaCooldown(1)); the divisor
    // must bring it to round(2000 / 3), not leave the nominal value.
    const r = checkFallbackError(429, "rate limit", 0, "p");
    expect(r.cooldownMs).toBe(Math.round(2000 / RATE_LIMIT_COOLDOWN_DIVISOR));
  });

  it("a 502 keeps its undivided short cooldown", () => {
    const r = checkFallbackError(502, "upstream unavailable", 0, "p");
    expect(r.cooldownMs).toBe(5000);
  });

  it("a 504 keeps its undivided short cooldown", () => {
    const r = checkFallbackError(504, "upstream unavailable", 0, "p");
    expect(r.cooldownMs).toBe(5000);
  });

  it("an unmatched transient error keeps the undivided default cooldown", () => {
    const r = checkFallbackError(500, "strange failure", 0, "p");
    expect(r.cooldownMs).toBe(TRANSIENT_COOLDOWN_MS);
  });

  it("a 401 keeps its undivided account cooldown", () => {
    const r = checkFallbackError(401, "unauthorized", 0, "p");
    expect(r.cooldownMs).toBe(COOLDOWN_MS.unauthorized);
  });
});
