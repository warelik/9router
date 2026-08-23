// upstream/tests/unit/demo-login-demo-lock.test.js
import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/auth/login/route.js";

const mocks = vi.hoisted(() => ({
  setCookie: vi.fn(),
  cookieStore: { set: vi.fn() },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({
    authMode: "oidc",
    oidcIssuerUrl: "https://issuer.example",
    oidcClientId: "client",
    tunnelUrl: "",
    tailscaleUrl: "",
    tunnelDashboardAccess: true,
  })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setCookie,
}));
vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: vi.fn(() => false),
}));
vi.mock("@/lib/blabs/flags", () => ({
  isDemoLock: vi.fn(() => true),
}));
vi.mock("@/lib/blabs/demoPolicy", () => ({
  assertDemoLockConfig: vi.fn(async () => ({ ok: true })),
  getDemoPassword: vi.fn(() => "Demo_Secret_For_Test_2026"),
}));

beforeEach(() => vi.clearAllMocks());

it("demo_password_login_succeeds_when_admin_auth_mode_oidc", async () => {
  const request = new Request("http://127.0.0.1/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "Demo_Secret_For_Test_2026", role: "admin" }),
  });
  const response = await POST(request);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    success: true,
    role: "demo",
  });
  expect(mocks.setCookie).toHaveBeenCalledWith(
    mocks.cookieStore,
    request,
    { role: "demo" },
  );
});
