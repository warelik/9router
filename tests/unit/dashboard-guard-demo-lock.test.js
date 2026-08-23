// upstream/tests/unit/dashboard-guard-demo-lock.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => {
  function NR(body, init) { return { status: init?.status || 200, body }; }
  NR.next = vi.fn(() => Symbol.for("n"));
  NR.json = vi.fn((body, init) => ({ status: init?.status || 200, body }));
  NR.redirect = vi.fn((url, status) => ({ status: typeof status === "number" ? status : 307, url: String(url) }));
  return {
    next: Symbol.for("n"), NR,
    getSettings: vi.fn(), validateApiKey: vi.fn(), getConsistentMachineId: vi.fn(),
    verifyDashboardAuthToken: vi.fn(), getDashboardAuthSession: vi.fn(),
  };
});
vi.mock("next/server", () => ({ NextResponse: m.NR }));
vi.mock("@/lib/localDb", () => ({ getSettings: m.getSettings, validateApiKey: m.validateApiKey }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: m.getConsistentMachineId }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: m.verifyDashboardAuthToken, getDashboardAuthSession: m.getDashboardAuthSession,
}));
const { proxy } = await import("../../src/dashboardGuard.js");

function req(path, { headers = {}, cookies = {}, method = "GET" } = {}) {
  return {
    method, nextUrl: { pathname: path, searchParams: new URL(`http://x${path}`).searchParams },
    headers: new Headers(headers),
    cookies: { get: (n) => (cookies[n] == null ? undefined : { value: cookies[n] }) },
    url: `http://localhost${path}`,
  };
}
const lock = (on) => { if (on) process.env.BLABS_DEMO_LOCK = "1"; else delete process.env.BLABS_DEMO_LOCK; };
const sess = (p) => { m.getDashboardAuthSession.mockResolvedValue(p); m.verifyDashboardAuthToken.mockResolvedValue(!!p); };
async function demo(path, opts = {}) {
  lock(true); sess({ role: "demo" });
  return proxy(req(path, { cookies: { auth_token: "t" }, ...opts }));
}
const locked = { error: "Forbidden", code: "demo_locked" };

describe("dashboard-guard-demo-lock", () => {
  beforeEach(() => {
    vi.clearAllMocks(); m.NR.next.mockReturnValue(m.next);
    m.getSettings.mockResolvedValue({ requireLogin: true });
    m.validateApiKey.mockResolvedValue(false);
    m.getConsistentMachineId.mockResolvedValue("cli-token");
    m.verifyDashboardAuthToken.mockResolvedValue(false);
    m.getDashboardAuthSession.mockResolvedValue(null); lock(false);
  });
  afterEach(() => { delete process.env.BLABS_DEMO_LOCK; });

  it("demo_lock_off_legacy_jwt_still_passes_dashboard", async () => {
    lock(false); sess({ authenticated: true });
    expect(await proxy(req("/dashboard", { cookies: { auth_token: "t" } }))).toBe(m.next);
  });
  it("demo_lock_on_legacy_unroled_jwt_redirects_login", async () => {
    lock(true); sess({ authenticated: true });
    const r = await proxy(req("/dashboard", { cookies: { auth_token: "t" } }));
    expect(r.status).toBe(307); expect(String(r.url)).toContain("/login");
  });
  it("demo_role_allows_showroom_page", async () => {
    expect(await demo("/dashboard/showroom")).toBe(m.next);
  });
  it("demo_role_document_deny_usage_is_303_to_showroom", async () => {
    const r = await demo("/dashboard/usage");
    expect(r.status).toBe(303); expect(String(r.url)).toContain("/dashboard/showroom");
  });
  it("demo_role_rsc_deny_usage_is_404", async () => {
    expect((await demo("/dashboard/usage", { headers: { RSC: "1" } })).status).toBe(404);
    expect((await demo("/dashboard/usage", { headers: { accept: "text/x-component" } })).status).toBe(404);
  });
  it("demo_role_allows_get_api_demo_stats", async () => {
    expect(await demo("/api/demo/stats", { method: "GET" })).toBe(m.next);
  });
  it("demo_role_denies_get_api_settings_403_demo_locked", async () => {
    const r = await demo("/api/settings", { method: "GET" });
    expect(r.status).toBe(403); expect(r.body).toEqual(locked);
  });
  it("demo_role_denies_get_api_keys", async () => {
    expect((await demo("/api/keys", { method: "GET" })).body.code).toBe("demo_locked");
  });
  it("demo_role_denies_get_api_usage_stats", async () => {
    expect((await demo("/api/usage", { method: "GET" })).body.code).toBe("demo_locked");
  });
  it("demo_role_denies_patch_api_settings", async () => {
    expect((await demo("/api/settings", { method: "PATCH" })).status).toBe(403);
  });
  it("demo_role_denies_post_api_keys", async () => {
    expect((await demo("/api/keys", { method: "POST" })).status).toBe(403);
  });
  it("admin_role_allows_get_api_settings_under_lock", async () => {
    lock(true); sess({ role: "admin" });
    expect(await proxy(req("/api/settings", { cookies: { auth_token: "t" }, method: "GET" }))).toBe(m.next);
  });
  it("demo_jwt_does_not_authorize_v1_without_api_key_remote", async () => {
    const r = await demo("/v1/models", { headers: { host: "router.example.com" } });
    expect(r.status).toBe(401); expect(r.body.error).toBe("API key required for remote API access");
  });
  it("demo_role_denies_always_protected_shutdown_before_jwt_success", async () => {
    const r = await demo("/api/shutdown", { method: "POST" });
    expect(r.status).toBe(403); expect(r.body).toEqual(locked);
  });
  it("demo_role_denies_always_protected_version_shutdown", async () => {
    expect((await demo("/api/version/shutdown", { method: "POST" })).status).toBe(403);
  });
  it("always_protected_null_role_under_lock_is_401", async () => {
    lock(true);
    const r = await proxy(req("/api/shutdown", { method: "POST" }));
    expect(r.status).toBe(401); expect(r.body).toEqual({ error: "Unauthorized" });
  });
  it("always_protected_admin_role_under_lock_allowed", async () => {
    lock(true); sess({ role: "admin" });
    expect(await proxy(req("/api/shutdown", { cookies: { auth_token: "t" }, method: "POST" }))).toBe(m.next);
  });
  it("demo_role_denies_oidc_test_under_lock_403", async () => {
    const r = await demo("/api/auth/oidc/test", { method: "GET" });
    expect(r.status).toBe(403); expect(r.body).toEqual(locked);
  });
  it("lock_on_ignores_requireLogin_false_for_dashboard", async () => {
    lock(true); m.getSettings.mockResolvedValue({ requireLogin: false });
    const r = await proxy(req("/dashboard"));
    expect(r.status).toBe(307); expect(String(r.url)).toContain("/login");
  });
});
