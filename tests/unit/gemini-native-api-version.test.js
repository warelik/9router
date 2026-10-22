import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn(), proxyAwareFetch: vi.fn(), getProviderCredentials: vi.fn(), buildModelsList: vi.fn() }));
vi.mock("../../src/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async model => {
    const slash = model.indexOf("/");
    return slash < 0 ? { provider: "gemini", model } : { provider: model.slice(0, slash), model: model.slice(slash + 1) };
  },
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: async () => true,
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: async () => {},
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: true }) }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));
const stable = await import("../../src/app/api/v1/models/[...model]/route.js");
const beta = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const MODEL = "gemini-3.5-flash-lite";
function body() {
  return { contents: [{ role: "user", parts: [{ text: "Initialize this task" }] }], generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: false }, seed: 7 }, futureTask: { type: "customer", args: [3] } };
}

describe("Gemini native stable and beta API versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleChat.mockImplementation(async () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] }));
    mocks.getProviderCredentials.mockResolvedValue({ apiKey: "fixture-provider-key", connectionId: "fixture-connection", providerSpecificData: {} });
    mocks.proxyAwareFetch.mockImplementation(async () => Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "audio fixture" }] } }] }));
    mocks.buildModelsList.mockResolvedValue([]);
  });

  it("the v1 model route exposes generation POST while retaining GET and OPTIONS", async () => {
    expect(typeof stable.POST).toBe("function");
    expect(typeof stable.GET).toBe("function");
    const response = await stable.OPTIONS();
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-headers").toLowerCase()).toContain("authorization");
  });

  // The earlier isolated alias tests missed the existing [...model] directory:
  // handler identity passed while Next rejected competing [...path]/[...model]
  // route patterns. Protect the actual filesystem route graph, not exports.
  it("has one active catch-all model route that Next can compile without ambiguous slugs", () => {
    const directory = new URL("../../src/app/api/v1/models/", import.meta.url);
    const routes = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\[\.\.\..+\]$/.test(entry.name))
      .filter(entry => ["js", "jsx", "ts", "tsx"].some(extension => existsSync(new URL(`${entry.name}/route.${extension}`, directory))))
      .map(entry => entry.name);
    expect(routes).toEqual(["[...model]"]);
  });

  it("preserves provider-prefixed OpenAI metadata GET independently of Gemini generation", async () => {
    const metadata = { id: "openai/example-model", object: "model", owned_by: "openai", context_length: 10000 };
    mocks.buildModelsList.mockResolvedValueOnce([metadata]);
    const response = await stable.GET(new Request("https://router.test/v1/models/openai/example-model"), { params: Promise.resolve({ model: ["openai", "example-model"] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(metadata);
    expect(mocks.buildModelsList).toHaveBeenCalledWith(["llm"]);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("preserves capability-list metadata GET", async () => {
    const metadata = { id: "image/example-model", object: "model", owned_by: "image" };
    mocks.buildModelsList.mockResolvedValueOnce([metadata]);
    const response = await stable.GET(new Request("https://router.test/v1/models/image"), { params: Promise.resolve({ model: ["image"] }) });
    expect(await response.json()).toEqual({ object: "list", data: [metadata] });
    expect(mocks.buildModelsList).toHaveBeenCalledWith(["image"]);
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  for (const segment of [MODEL, `${MODEL}:generateContentExtra`, `${MODEL}:countTokens`]) {
    it(`rejects non-generation metadata POST ${segment} before delegation`, async () => {
      const response = await stable.POST(new Request(`https://router.test/v1/models/${segment}`, { method: "POST" }), { params: Promise.resolve({ model: [segment] }) });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, OPTIONS");
      expect(mocks.handleChat).not.toHaveBeenCalled();
      expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
    });
  }

  for (const provider of ["gemini", "aistudio"]) {
    for (const version of ["v1", "v1beta"]) {
      for (const action of ["generateContent", "streamGenerateContent"]) {
        it(`${provider}: ${version} ${action} preserves native input and forwards API version metadata`, async () => {
          const input = body();
          const query = action === "streamGenerateContent" ? "?alt=sse&key=fixture-client-key&fields=candidates" : "?key=fixture-client-key&fields=candidates";
          const url = `https://router.test/${version}/models/${provider}/${MODEL}:${action}${query}`;
          const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": "fixture-client-key" }, body: JSON.stringify(input) });
          const route = version === "v1" ? stable : beta;
          const routeParams = version === "v1" ? { model: [provider, `${MODEL}:${action}`] } : { path: [provider, `${MODEL}:${action}`] };
          const response = await route.POST(request, { params: Promise.resolve(routeParams) });
          expect(response.status).toBe(200);
          expect(mocks.handleChat).toHaveBeenCalledTimes(1);
          const [forwarded, raw, options] = mocks.handleChat.mock.calls[0];
          const stream = action === "streamGenerateContent";
          expect(await forwarded.json()).toEqual({ ...input, model: `${provider}/${MODEL}`, stream });
          expect(forwarded.url).toBe(url);
          expect(raw.body).toEqual(input);
          expect(raw.apiVersion).toBe(version);
          expect(raw.queryParams).not.toContainEqual(["key", "fixture-client-key"]);
          expect(options).toMatchObject({ sourceFormatOverride: "gemini", stream });
          const credentials = { nativeGeminiPassthrough: true, nativeGeminiRequest: { apiVersion: raw.apiVersion, query: raw.queryParams } };
          const executor = new DefaultExecutor(provider);
          const upstream = new URL(executor.buildUrl(MODEL, stream, 0, credentials));
          expect(upstream.pathname).toBe(`/${version}/models/${MODEL}:${action}`);
          expect(upstream.searchParams.get("fields")).toBe("candidates");
          expect(upstream.searchParams.has("key")).toBe(false);
          expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
        });
      }
    }
  }

  for (const version of ["v1", "v1beta"]) {
    for (const action of ["generateContent", "streamGenerateContent"]) {
      it(`${version} ${action} preserves nested provider model IDs`, async () => {
        const model = "kilocode/google/gemini-2.5-pro";
        const input = body();
        const request = new Request(`https://router.test/${version}/models/${model}:${action}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const segments = ["kilocode", "google", `gemini-2.5-pro:${action}`];
        const route = version === "v1" ? stable : beta;
        const params = version === "v1" ? { model: segments } : { path: segments };
        const response = await route.POST(request, { params: Promise.resolve(params) });
        expect(response.status).toBe(200);
        expect(mocks.handleChat).toHaveBeenCalledTimes(1);
        const [forwarded, raw] = mocks.handleChat.mock.calls[0];
        expect(await forwarded.json()).toMatchObject({ model, stream: action === "streamGenerateContent" });
        expect(raw.apiVersion).toBe(version);
        expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
      });
    }
  }

  it("the native AUDIO path forwards stable v1 to Google", async () => {
    const input = { contents: [{ parts: [{ text: "Speak" }] }], generationConfig: { responseModalities: ["AUDIO"] } };
    const request = new Request("https://router.test/v1/models/tts-model:generateContent?key=fixture-client-key&fields=candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const response = await stable.POST(request, { params: Promise.resolve({ model: ["tts-model:generateContent"] }) });
    expect(response.status).toBe(200);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.proxyAwareFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/models/tts-model:generateContent");
    expect(new URL(url).searchParams.has("key")).toBe(false);
    expect(JSON.parse(options.body)).toEqual(input);
    await response.arrayBuffer();
  });

  for (const version of ["v1", "v1beta"]) {
    it(`${version} accepts the documented $key alias without sending either client key upstream`, async () => {
      const input = body();
      const request = new Request(`https://router.test/${version}/models/gemini/${MODEL}:generateContent?$key=fixture-client-key&fields=candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const route = version === "v1" ? stable : beta;
      const params = version === "v1" ? { model: ["gemini", `${MODEL}:generateContent`] } : { path: ["gemini", `${MODEL}:generateContent`] };
      expect((await route.POST(request, { params: Promise.resolve(params) })).status).toBe(200);
      const [forwarded, raw] = mocks.handleChat.mock.calls[0];
      expect(forwarded.headers.get("authorization")).toBe("Bearer fixture-client-key");
      expect(raw.queryParams).toEqual([["fields", "candidates"]]);
      const executor = new DefaultExecutor("gemini");
      const credentials = { nativeGeminiPassthrough: true, nativeGeminiRequest: { apiVersion: version, query: [["key", "fixture-client-key"], ["$key", "fixture-client-key"], ["fields", "candidates"]] } };
      const upstream = new URL(executor.buildUrl(MODEL, false, 0, credentials));
      expect(upstream.searchParams.has("key")).toBe(false);
      expect(upstream.searchParams.has("$key")).toBe(false);
      expect(upstream.searchParams.get("fields")).toBe("candidates");
    });
  }

  it("accepts the $key alias on the native AUDIO path without leaking it to Google", async () => {
    const input = { contents: [{ parts: [{ text: "Speak" }] }], generationConfig: { responseModalities: ["AUDIO"] } };
    const request = new Request("https://router.test/v1beta/models/tts-model:generateContent?$key=fixture-client-key&fields=candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const response = await beta.POST(request, { params: Promise.resolve({ path: ["tts-model:generateContent"] }) });
    expect(response.status).toBe(200);
    const [url, options] = mocks.proxyAwareFetch.mock.calls[0];
    expect(new URL(url).searchParams.has("$key")).toBe(false);
    expect(new URL(url).searchParams.has("key")).toBe(false);
    expect(options.headers["x-goog-api-key"]).toBe("fixture-provider-key");
    expect(JSON.parse(options.body)).toEqual(input);
    await response.arrayBuffer();
  });

  it("does not change a translated client's configured provider API version", () => {
    for (const provider of ["gemini", "aistudio"]) {
      const executor = new DefaultExecutor(provider);
      const url = new URL(executor.buildUrl(MODEL, false, 0, { nativeGeminiRequest: { apiVersion: "v1" } }));
      expect(url.pathname).toBe(`/v1beta/models/${MODEL}:generateContent`);
    }
  });

});
