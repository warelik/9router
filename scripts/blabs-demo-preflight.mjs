import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
// path.resolve+dirname (not new URL("..")) so Next/webpack can bundle this module
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_PASSWORD = "123456";
const WEAK_DEMO_PASSWORDS = new Set([
  "123456",
  "password",
  "demo",
  "demo123",
  "admin",
  "blabs",
  "showroom",
]);
const DEMO_PASSWORD_RE = /^[A-Za-z0-9!@#%^*_=+.-]{16,128}$/;

export function normalizeDemoPasswordBytes(raw) {
  if (raw == null || raw === "") return null;
  let bytes;
  if (typeof raw === "string") {
    if (raw.includes("\0") || raw.includes("\r") || raw.includes("\n")) return null;
    bytes = Buffer.from(raw, "utf8");
  } else {
    bytes = Buffer.from(raw);
    if (bytes.includes(0) || bytes.includes(13)) return null;
    if (bytes.at(-1) === 10) {
      if (bytes.length > 1 && bytes.at(-2) === 10) return null;
      bytes = bytes.subarray(0, -1);
    }
    if (bytes.includes(10)) return null;
  }
  const text = bytes.toString("utf8");
  if (!DEMO_PASSWORD_RE.test(text) || WEAK_DEMO_PASSWORDS.has(text.toLowerCase())) {
    return null;
  }
  return text;
}

export function getDemoPassword(env = process.env) {
  if (!isDemoLockEnv(env)) return null;
  return normalizeDemoPasswordBytes(env.BLABS_DEMO_PASSWORD);
}

export function isDemoLockEnv(env = process.env) {
  return ["1", "true", "yes"].includes(
    String(env.BLABS_DEMO_LOCK || "").toLowerCase(),
  );
}

export function resolveDataDir(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  const fallback =
    platform === "win32"
      ? path.join(
          env.APPDATA || path.join(home, "AppData", "Roaming"),
          "9router",
        )
      : path.join(home, ".9router");
  const configured = env.DATA_DIR;
  if (!configured) return fallback;
  if (platform === "win32" && /^\//.test(configured)) return fallback;
  return path.resolve(projectRoot, configured);
}

export function readStoredPasswordHash(env = process.env) {
  const dbPath = path.join(resolveDataDir(env), "db", "data.sqlite");
  if (!fs.existsSync(dbPath)) return null;

  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only = ON");
    const row = db
      .prepare("SELECT data FROM settings WHERE id = 1")
      .get();
    if (!row) return null;
    const settings = JSON.parse(row.data);
    return typeof settings.password === "string" && settings.password
      ? settings.password
      : null;
  } finally {
    db.close();
  }
}

export async function assertDemoLockConfig(env = process.env) {
  if (!isDemoLockEnv(env)) return { ok: true };

  const raw = env.BLABS_DEMO_PASSWORD;
  const demoPassword = normalizeDemoPasswordBytes(raw);
  if (!demoPassword) {
    return { ok: false, error: raw ? "weak_password" : "missing_password" };
  }

  let storedHash;
  try {
    storedHash = readStoredPasswordHash(env);
  } catch {
    return { ok: false, error: "settings_read_failed" };
  }

  try {
    const matchesAdmin = storedHash
      ? await bcrypt.compare(demoPassword, storedHash)
      : demoPassword === (env.INITIAL_PASSWORD || DEFAULT_PASSWORD);
    return matchesAdmin
      ? { ok: false, error: "demo_password_equals_admin" }
      : { ok: true };
  } catch {
    return { ok: false, error: "admin_password_check_failed" };
  }
}
