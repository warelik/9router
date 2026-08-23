import { assertDemoLockConfig, getDemoPassword } from "../../../scripts/blabs-demo-preflight.mjs";
import { isDemoLock } from "./flags.js";

/** @typedef {"admin"|"demo"} DashboardRole */

export const WEAK_DEMO_PASSWORDS = Object.freeze([
  "123456", "password", "demo", "demo123", "admin", "blabs", "showroom",
]);

/**
 * When !isDemoLock(): always { ok: true }
 * When isDemoLock():
 *   missing/empty/unvalidated BLABS_DEMO_PASSWORD (normalizeDemoPasswordBytes null) →
 *     missing_password when unset/empty; weak_password when present but fails
 *     NUL/CR/LF/charset/length/weak deny
 *   standalone preflight reports equality to stored bcrypt or fallback admin password
 *     → { ok:false, error:"demo_password_equals_admin" }
 *   else { ok: true }
 * Re-exports the alias-free standalone preflight from
 * "../../../scripts/blabs-demo-preflight.mjs"; no startup code imports @ aliases.
 */
export { assertDemoLockConfig, getDemoPassword };

/**
 * If !isDemoLock(): return.
 * Else await assertDemoLockConfig(); if !ok → console.error redacted reason (error code only; never password) → process.exit(1).
 */
export async function enforceDemoLockStartupOrExit() {
  if (!isDemoLock()) return;
  const result = await assertDemoLockConfig();
  if (result.ok) return;
  console.error(`[blabs-demo-lock] ${result.error}`);
  process.exit(1);
}

/**
 * @param {Record<string, unknown>|null|undefined} payload
 * @returns {DashboardRole|null}
 */
export function resolveDashboardRole(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!isDemoLock()) {
    if (payload.role === "admin" || payload.role === "demo") return payload.role;
    if (payload.authenticated === true || payload.role == null) return "admin";
    return null;
  }
  if (payload.role === "admin" || payload.role === "demo") return payload.role;
  return null;
}

export const DEMO_PAGE_ALLOWLIST = Object.freeze(["/dashboard/showroom"]);

export const DEMO_API_ALLOWLIST = Object.freeze([
  { path: "/api/demo/stats", methods: Object.freeze(["GET"]) },
  { path: "/api/auth/login", methods: Object.freeze(["POST"]) },
  { path: "/api/auth/logout", methods: Object.freeze(["POST"]) },
  { path: "/api/auth/status", methods: Object.freeze(["GET"]) },
  { path: "/api/settings/require-login", methods: Object.freeze(["GET"]) },
  { path: "/api/health", methods: Object.freeze(["GET"]) },
  { path: "/api/init", methods: Object.freeze(["GET"]) },
  { path: "/api/locale", methods: Object.freeze(["POST"]) },
  { path: "/api/version", methods: Object.freeze(["GET"]) },
]);

export function isDemoPageAllowed(pathname) {
  return DEMO_PAGE_ALLOWLIST.includes(pathname);
}

export function isDemoApiAllowed(pathname, method) {
  const m = String(method || "").toUpperCase();
  return DEMO_API_ALLOWLIST.some(
    (entry) => entry.path === pathname && entry.methods.includes(m),
  );
}

export function scrubRequireLoginResponse(_settingsSlice) {
  return { requireLogin: true, tunnelDashboardAccess: false };
}
