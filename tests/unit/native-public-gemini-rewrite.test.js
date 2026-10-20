// The deployed alpha failure occurred before any API handler/provider call:
// importing the private route does not test Next's public rewrite front door.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import nextConfig from "../../next.config.mjs";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match.js";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination.js";

const guardMocks = vi.hoisted(() => ({ validateApiKey: vi.fn() }));
vi.mock("next/server", () => ({
  NextResponse: {
    next: () => ({ kind: "next" }),
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireLogin: true }),
  validateApiKey: guardMocks.validateApiKey,
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "fixture-cli-token" }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: async () => false }));

const { proxy: dashboardGuardProxy } = await import("../../src/dashboardGuard.js");

const rules = await nextConfig.rewrites();
function rewrite(url, rewrites = rules) {
  const input = new URL(url);
  const query = {};
  for (const name of new Set(input.searchParams.keys())) {
    const values = input.searchParams.getAll(name);
    query[name] = values.length === 1 ? values[0] : values;
  }
  for (const rule of rewrites) {
    const params = getPathMatch(rule.source, { removeUnnamedParams: true })(input.pathname);
    if (params === false) continue;
    return { rule, ...prepareDestination({ destination: rule.destination, params, query, appendParamsToQuery: true }) };
  }
  return null;
}

function remoteRequest(path, headers = {}) {
  const request = new Request(`https://router.example${path}`, {
    headers: { host: "router.example", ...headers },
  });
  Object.defineProperty(request, "nextUrl", { value: new URL(request.url) });
  Object.defineProperty(request, "cookies", { value: { get: () => undefined } });
  return request;
}

describe("public native Gemini generation rewrites", () => {
  for (const version of ["v1", "v1beta", "v1alpha"]) {
    it(`${version} registers both public root and wildcard destinations`, () => {
      expect(rules).toContainEqual({ source: `/${version}/:path*`, destination: `/api/${version}/:path*` });
      expect(rules).toContainEqual({ source: `/${version}`, destination: `/api/${version}` });
    });

    it(`${version} resolves the public root through Next's real matcher`, () => {
      const resolved = rewrite(`https://router.test/${version}?fields=models&key=fixture-client-key`);
      expect(resolved).not.toBeNull();
      expect(resolved.parsedDestination.pathname).toBe(`/api/${version}`);
      expect(resolved.parsedDestination.query).toEqual({ fields: "models", key: "fixture-client-key" });
    });

    for (const provider of ["gemini", "aistudio"]) {
      for (const action of ["generateContent", "streamGenerateContent"]) {
        it(`${version} ${provider} ${action} preserves native provider/model/action/query on the public path`, () => {
          const suffix = `/models/${provider}/gemini-3.5-flash-lite(high):${action}`;
          const resolved = rewrite(`https://router.test/${version}${suffix}?alt=sse&$key=fixture-client-key&fields=candidates(content,finishReason)&trace=one&trace=two`);
          expect(resolved).not.toBeNull();
          expect(resolved.parsedDestination.pathname).toBe(`/api/${version}${suffix}`);
          expect(resolved.parsedDestination.query).toEqual({
            alt: "sse", "$key": "fixture-client-key", fields: "candidates(content,finishReason)", trace: ["one", "two"],
          });
          expect(resolved.parsedDestination.query.path).toBeUndefined();
          expect(resolved.parsedDestination.hostname).toBeNull();
        });
      }
    }
  }

  it("reproduces the local alpha 404 front door when its rewrites are absent despite the private handler", () => {
    expect(existsSync(new URL("../../src/app/api/v1alpha/models/[...path]/route.js", import.meta.url))).toBe(true);
    const withoutAlpha = rules.filter(rule => !rule.source.startsWith("/v1alpha"));
    expect(rewrite("https://router.test/v1alpha/models/aistudio/gemini-3.5-flash-lite:generateContent", withoutAlpha)).toBeNull();
    expect(rewrite("https://router.test/v1beta/models/aistudio/gemini-3.5-flash-lite:generateContent", withoutAlpha)?.parsedDestination.pathname)
      .toBe("/api/v1beta/models/aistudio/gemini-3.5-flash-lite:generateContent");
  });

  it("does not rewrite a lookalike API version", () => {
    expect(rewrite("https://router.test/v1alphabet/models/gemini/gemini-3.5-flash-lite:generateContent")).toBeNull();
  });
});

describe("v1alpha middleware authentication before Next rewrites", () => {
  beforeEach(() => {
    guardMocks.validateApiKey.mockReset().mockImplementation(async key => key === "fixture-alpha-key");
  });

  for (const path of [
    "/v1alpha/models/gemini/gemini-3.5-flash-lite:generateContent",
    "/api/v1alpha/models/gemini/gemini-3.5-flash-lite:generateContent",
  ]) {
    it(`rejects an unauthenticated remote request to ${path}`, async () => {
      const response = await dashboardGuardProxy(remoteRequest(path));
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("API key required for remote API access");
      expect(guardMocks.validateApiKey).not.toHaveBeenCalled();
    });

    it(`allows a valid $key on ${path}`, async () => {
      const response = await dashboardGuardProxy(remoteRequest(`${path}?$key=fixture-alpha-key`));
      expect(response).toEqual({ kind: "next" });
      expect(guardMocks.validateApiKey).toHaveBeenCalledWith("fixture-alpha-key");
    });
  }

  it("preserves Bearer, header, and key precedence before the $key alias", async () => {
    const cases = [
      [{ authorization: "Bearer fixture-alpha-key", "x-api-key": "other", "x-goog-api-key": "other" }, "?key=other&$key=other", "fixture-alpha-key"],
      [{ "x-api-key": "fixture-alpha-key", "x-goog-api-key": "other" }, "?key=other&$key=other", "fixture-alpha-key"],
      [{ "x-goog-api-key": "fixture-alpha-key" }, "?key=other&$key=other", "fixture-alpha-key"],
      [{}, "?key=fixture-alpha-key&$key=other", "fixture-alpha-key"],
      [{}, "?$key=fixture-alpha-key", "fixture-alpha-key"],
    ];
    for (const [headers, query, selected] of cases) {
      guardMocks.validateApiKey.mockClear();
      const response = await dashboardGuardProxy(remoteRequest(
        `/v1alpha/models/gemini/gemini-3.5-flash-lite:generateContent${query}`, headers));
      expect(response).toEqual({ kind: "next" });
      expect(guardMocks.validateApiKey).toHaveBeenCalledWith(selected);
    }
  });
});
