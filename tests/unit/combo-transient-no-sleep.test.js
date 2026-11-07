// Regression: a transient 502/503/504 from one combo model must move to the next
// model at once, without sleeping on the account cooldown. The short cooldown only
// marks the account unavailable; it must never delay the current request.
import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

// combo reads ok, status, headers, body, clone and statusText from the result object.
function resultFor(status, ok) {
  const make = () => new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const response = make();
  return {
    ok,
    status,
    statusText: "",
    headers: response.headers,
    body: response.body,
    clone: () => make(),
  };
}

describe("combo transient 502/503/504 do not sleep before the next model", () => {
  for (const status of [502, 503, 504]) {
    it(`status ${status}: the next model runs without waiting on the cooldown`, async () => {
      const calls = [];
      const handleSingleModel = async (_body, modelStr) => {
        calls.push({ modelStr, at: Date.now() });
        if (modelStr === "p/first") return resultFor(status, false);
        return resultFor(200, true);
      };

      const started = Date.now();
      const result = await handleComboChat({
        body: { model: "combo", messages: [{ role: "user", content: "hi" }] },
        models: ["p/first", "p/second"],
        handleSingleModel,
        log,
      });
      const elapsed = Date.now() - started;

      expect(calls.map(c => c.modelStr)).toEqual(["p/first", "p/second"]);
      // Without the sleep the whole handoff is effectively immediate; the old 5s pause
      // would blow well past this bound.
      expect(elapsed).toBeLessThan(1000);
      expect(result).toBeDefined();
    });
  }
});

describe("account cooldown classification stays short", () => {
  it("a bare 502 gets the transient account cooldown, not a sleep budget", () => {
    const r = checkFallbackError(502, "upstream unavailable", 0, "p");
    expect(r.shouldFallback).toBe(true);
    expect(typeof r.cooldownMs).toBe("number");
    expect(r.cooldownMs).toBeGreaterThan(0);
  });

});
