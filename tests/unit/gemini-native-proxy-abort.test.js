// The actual proxy layer captures originalFetch at import time. Stub that
// boundary first; unlike core dispatch tests this exercises its catch/fallback
// logic and BaseExecutor retries without allowing any network traffic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fetchBoundary;
let proxyAwareFetch;
let DefaultExecutor;

beforeEach(async () => {
  vi.resetModules();
  fetchBoundary = vi.fn();
  vi.stubGlobal("fetch", fetchBoundary);
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  ({ DefaultExecutor } = await import("../../open-sse/executors/default.js"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const proxy = strictProxy => ({ connectionProxyEnabled: true, connectionProxyUrl: "http://offline-proxy.invalid:18080", strictProxy });

describe("native Gemini cancellation through the real proxy layer", () => {
  it.each([
    ["regular proxy", "https://generativelanguage.googleapis.com/v1beta/models/offline:generateContent", true],
    ["regular non-strict proxy", "https://generativelanguage.googleapis.com/v1beta/models/offline:generateContent", false],
    ["MITM bypass proxy", "https://cloudcode-pa.googleapis.com/v1internal:generateContent", true],
    ["MITM bypass non-strict proxy", "https://cloudcode-pa.googleapis.com/v1internal:generateContent", false],
  ])("keeps AbortError identity and avoids direct fallback: %s", async (_name, url, strict) => {
    const abort = new DOMException("offline cancellation", "AbortError");
    fetchBoundary.mockRejectedValue(abort);
    await expect(proxyAwareFetch(url, { signal: AbortSignal.abort() }, proxy(strict))).rejects.toBe(abort);
    expect(fetchBoundary).toHaveBeenCalledOnce();
    expect(fetchBoundary.mock.calls[0][1].dispatcher).toBeDefined();
  });

  it("preserves strict proxy failure instead of silently retrying the direct connection", async () => {
    fetchBoundary.mockRejectedValue(new Error("offline proxy refused"));
    await expect(proxyAwareFetch("https://generativelanguage.googleapis.com/offline", {}, proxy(true))).rejects.toThrow("Proxy required but failed");
    expect(fetchBoundary).toHaveBeenCalledOnce();
    expect(fetchBoundary.mock.calls[0][1].dispatcher).toBeDefined();
  });

  it("retains the existing permitted direct fallback for a non-strict non-abort error", async () => {
    fetchBoundary.mockRejectedValueOnce(new Error("offline proxy refused")).mockResolvedValueOnce(new Response("offline fallback result"));
    const response = await proxyAwareFetch("https://generativelanguage.googleapis.com/offline", {}, proxy(false));
    expect(await response.text()).toBe("offline fallback result");
    expect(fetchBoundary).toHaveBeenCalledTimes(2);
    expect(fetchBoundary.mock.calls[0][1].dispatcher).toBeDefined();
    expect(fetchBoundary.mock.calls[1][1].dispatcher).toBeUndefined();
  });

  it.each(["gemini", "aistudio"])("%s: non-DOMException abort reason does not trigger executor retries and clears the connect timer", async provider => {
    const client = new AbortController();
    const customReason = new Error("offline caller cancelled with custom reason");
    fetchBoundary.mockImplementationOnce(async (_url, options) => {
      client.abort(customReason);
      expect(options.signal.aborted).toBe(true);
      throw customReason;
    });
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const executor = new DefaultExecutor(provider);
    const operation = executor.execute({
      model: "gemini-3.5-flash-lite", body: { contents: [{ role: "user", parts: [{ text: "offline abort" }] }] }, stream: false,
      credentials: { apiKey: "offline-key", providerSpecificData: {} }, signal: client.signal, proxyOptions: proxy(true),
    });
    try {
      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchBoundary).toHaveBeenCalledOnce();
      const timerHandles = setTimer.mock.results.filter(result => result.type === "return").map(result => result.value);
      expect(timerHandles.length).toBeGreaterThan(0);
      for (const handle of timerHandles) expect(clearTimer).toHaveBeenCalledWith(handle);
    } finally {
      // Keep a failed cleanup assertion from leaving a live 60-second timer.
      for (const result of setTimer.mock.results) if (result.type === "return") clearTimeout(result.value);
    }
  });
});
