// Regression for the combo account-wait contract (0064). Waiting only happens when
// the caller provides holdDeadlineAt; without it the historical immediate handoff
// is kept. The wait ends at the deadline, stops on client abort, and an expired
// deadline reports the router's own 502 instead of relaying an upstream 429/503.
import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

// combo reads ok, status, headers, body, clone and statusText from the result object.
function resultFor(status, ok) {
  const make = () => new Response(JSON.stringify({ error: { message: "account exhausted" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const response = make();
  return { ok, status, statusText: "", headers: response.headers, body: response.body, clone: () => make() };
}

// Every member fails on account exhaustion (429), so only waiting can change the outcome.
function exhaustedMember() {
  const calls = [];
  const handleSingleModel = async (_body, modelStr) => {
    calls.push(modelStr);
    return resultFor(429, false);
  };
  return { calls, handleSingleModel };
}

describe("combo account wait is driven by holdDeadlineAt only", () => {
  it("without holdDeadlineAt, exhaustion is handed back at once (no wait pass)", async () => {
    const { calls, handleSingleModel } = exhaustedMember();
    const started = Date.now();
    await handleComboChat({
      body: { model: "combo", messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    // One pass only: no re-pass of the member list.
    expect(calls).toEqual(["p/a", "p/b"]);
  });

  it("with an expired holdDeadlineAt, the router answers 502 instead of 429", async () => {
    const { handleSingleModel } = exhaustedMember();
    const result = await handleComboChat({
      body: { model: "combo", messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      holdDeadlineAt: Date.now() - 1,
    });
    expect(result.status).toBe(502);
  });

  it("with a live holdDeadlineAt, exhausted members are re-passed until the deadline", async () => {
    const { calls, handleSingleModel } = exhaustedMember();
    const deadline = Date.now() + 1500;
    await handleComboChat({
      body: { model: "combo", messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      holdDeadlineAt: deadline,
    });
    // More than one pass proves the wait re-pass ran; the deadline bounds it.
    expect(calls.length).toBeGreaterThan(2);
    expect(Date.now()).toBeGreaterThanOrEqual(deadline - 50);
  });

  it("a client abort during the wait ends it at once", async () => {
    const { calls, handleSingleModel } = exhaustedMember();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await handleComboChat({
      body: { model: "combo", messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      holdDeadlineAt: Date.now() + 5000,
      clientSignal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
