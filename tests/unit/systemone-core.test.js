import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";

const originalFetch = globalThis.fetch;
const body = () => ({ state: { turn: 1 }, questions: { q1: { text: "Which?" } }, model: "caller-supplied" });
const cloudflare = { provider: "cloudflare-ai", model: "@cf/cloudflare/clef-flash" };
const cloudflareCredentials = () => ({ apiKey: "cf-token", providerSpecificData: { accountId: "acct123" } });
const json = (payload, status = 200) => new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock; });
afterEach(() => { globalThis.fetch = originalFetch; });

async function run(modelInfo, credentials, requestBody = body()) {
  const onRequestSuccess = vi.fn();
  const out = await handleSystemoneCore({ body: requestBody, modelInfo, credentials, onRequestSuccess });
  return { out, onRequestSuccess };
}

describe("System One Cloudflare response envelope", () => {
  it("unwraps result, counts usage once and leaves the request unchanged", async () => {
    const native = { model: "clef-flash", answers: { q1: "A" }, usage: { input_tokens: 11, output_tokens: 4 } };
    fetchMock.mockResolvedValue(json({ success: true, errors: [], messages: [], result: native }));
    const { out, onRequestSuccess } = await run(cloudflare, cloudflareCredentials());
    expect(out.success).toBe(true);
    expect(await out.response.json()).toEqual(native);
    expect(out.usage).toEqual({ prompt_tokens: 11, completion_tokens: 4 });
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash");
    expect(init.headers.Authorization).toBe("Bearer cf-token");
    expect(JSON.parse(init.body)).toEqual({ ...body(), model: "clef-flash" });
  });

  it("returns 502 and skips the success callback for an unsuccessful envelope", async () => {
    fetchMock.mockResolvedValue(json({ success: false, errors: [{ code: 1000, message: "model unavailable" }], result: null }));
    const { out, onRequestSuccess } = await run(cloudflare, cloudflareCredentials());
    expect(out.success).toBe(false);
    expect(out.status).toBe(502);
    expect(out.error).toContain("model unavailable");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { success: true }],
    ["null", { success: true, result: null }],
    ["scalar", { success: true, result: "text" }],
    ["array", { success: true, result: [1] }],
  ])("returns 502 for a %s result", async (_label, payload) => {
    fetchMock.mockResolvedValue(json(payload));
    const { out, onRequestSuccess } = await run(cloudflare, cloudflareCredentials());
    expect(out.success).toBe(false);
    expect(out.status).toBe(502);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("keeps non-2xx provider errors and invalid JSON handling", async () => {
    fetchMock.mockResolvedValueOnce(json({ errors: [{ message: "bad token" }] }, 401));
    const unauthorized = await run(cloudflare, cloudflareCredentials());
    expect(unauthorized.out.success).toBe(false);
    expect(unauthorized.out.status).toBe(401);
    expect(unauthorized.onRequestSuccess).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json("not json"));
    const invalid = await run(cloudflare, cloudflareCredentials());
    expect(invalid.out.status).toBe(502);
    expect(invalid.out.error).toContain("Invalid JSON response from cloudflare-ai");
    expect(invalid.onRequestSuccess).not.toHaveBeenCalled();
  });
});

describe("System One providers without an envelope", () => {
  it("passes a v1m JSON response through exactly", async () => {
    const native = { success: false, result: "kept", answers: { q1: "A" }, usage: { input_tokens: 3, output_tokens: 2 } };
    fetchMock.mockResolvedValue(json(native));
    const { out, onRequestSuccess } = await run({ provider: "v1m", model: "rev-latest" }, { apiKey: "v1m-token" });
    expect(out.success).toBe(true);
    expect(await out.response.json()).toEqual(native);
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://v1m.ir/v1/systemone");
  });
});
