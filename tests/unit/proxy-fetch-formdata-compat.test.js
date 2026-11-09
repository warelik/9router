import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("proxyFetch FormData compatibility", () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    globalThis.fetch = savedFetch;
    vi.doUnmock("undici");
  });

  async function mockUndici(fetchMock) {
    const actual = await vi.importActual("undici");
    class UndiciFormData extends actual.FormData {}
    vi.doMock("undici", () => ({
      ...actual,
      fetch: fetchMock,
      FormData: UndiciFormData,
    }));
    return UndiciFormData;
  }

  it("rebinds a global FormData body to the Undici package implementation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    const UndiciFormData = await mockUndici(fetchMock);

    const { proxyAwareFetch, resetDirectDispatchersForTests } =
      await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const body = new FormData();
    body.append(
      "index.js",
      new Blob(["export default {}"], { type: "application/javascript+module" }),
      "index.js",
    );
    body.append(
      "metadata",
      new Blob([JSON.stringify({ main_module: "index.js" })], {
        type: "application/json",
      }),
      "metadata.json",
    );
    body.append("plain", "value");

    await proxyAwareFetch("https://api.cloudflare.com/client/v4/test", {
      method: "PUT",
      body,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = fetchMock.mock.calls[0][1].body;
    expect(sentBody).toBeInstanceOf(UndiciFormData);
    expect(sentBody).not.toBe(body);
    expect(sentBody.get("plain")).toBe("value");

    const script = sentBody.get("index.js");
    expect(script.name).toBe("index.js");
    expect(script.type).toBe("application/javascript+module");
    await expect(script.text()).resolves.toBe("export default {}");

    const metadata = sentBody.get("metadata");
    expect(metadata.name).toBe("metadata.json");
    expect(metadata.type).toBe("application/json");
    await expect(metadata.text()).resolves.toBe(
      JSON.stringify({ main_module: "index.js" }),
    );
  });

  it("leaves an Undici FormData body untouched", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    const UndiciFormData = await mockUndici(fetchMock);

    const { proxyAwareFetch, resetDirectDispatchersForTests } =
      await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const body = new UndiciFormData();
    body.append("field", "value");

    await proxyAwareFetch("https://example.test/upload", {
      method: "POST",
      body,
    });

    expect(fetchMock.mock.calls[0][1].body).toBe(body);
  });
});
