import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
const IDS = Array.from({ length: 37 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`);
const WEAK = new Set(["123456","password","demo","demo123","admin","blabs","showroom"]);
const REQUIRED = ["base", "mode", "demo-cookie-jar", "admin-cookie-jar", "demo-password-file", "api-key-file", "browser-evidence-dir", "host-evidence"];
const argv = process.argv.slice(2);
function usage(message) { console.error(`[blabs-demo-lock-audit] ${message}`); process.exit(2); }
if (argv.length !== REQUIRED.length * 2) usage("missing_input");
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith("--")) usage("missing_input");
  const key = argv[i].slice(2);
  if (args[key] !== undefined) usage("duplicate_flag");
  if (!REQUIRED.includes(key)) usage("unknown_flag");
  args[key] = argv[i + 1];
}
if (!["local", "remote"].includes(args.mode)) usage("invalid_mode");
let base;
try { base = new URL(args.base); } catch { usage("invalid_base"); }
if (!["http:", "https:"].includes(base.protocol)) usage("invalid_base");
if (args.mode === "local" && (base.protocol !== "http:" || base.hostname !== "127.0.0.1")) usage("local_base_not_loopback");
if (args.mode === "remote") { const parts = base.hostname.split("."); if (base.protocol !== "https:" || parts.length !== 3 || parts[1] !== "trycloudflare" || parts[2] !== "com" || !/^[a-z0-9-]+$/i.test(parts[0])) usage("remote_base_not_trycloudflare"); }
function mode600(file) {
  try { const stat = fs.statSync(file); if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) usage("input_mode"); return fs.realpathSync(file); }
  catch { usage("input_missing"); }
}
function readSecretFile(file, kind) {
  let raw = fs.readFileSync(file);
  if (raw.includes(0) || raw.includes(13)) usage("secret_bytes");
  if (raw.at(-1) === 10) { if (raw.length > 1 && raw.at(-2) === 10) usage("secret_trailing_lf"); raw = raw.subarray(0, -1); }
  if (raw.includes(10)) usage("secret_internal_lf");
  const text = raw.toString("utf8");
  if (kind === "demo") {
    if (!/^[A-Za-z0-9!@#%^*_=+.-]{16,128}$/.test(text) || WEAK.has(text.toLowerCase())) usage("demo_password_weak");
  } else if (!text) usage("empty_secret_file");
  return text;
}
const demoJar = mode600(args["demo-cookie-jar"]), adminJar = mode600(args["admin-cookie-jar"]);
const demoFile = mode600(args["demo-password-file"]), apiFile = mode600(args["api-key-file"]), hostFile = mode600(args["host-evidence"]);
if (demoJar === adminJar) usage("cookie_jars_not_distinct");
let browserDir;
try { browserDir = fs.realpathSync(args["browser-evidence-dir"]); const bstat = fs.statSync(browserDir); if (!bstat.isDirectory() || (bstat.mode & 0o777) !== 0o700) usage("browser_evidence_mode"); }
catch { usage("browser_evidence_missing"); }
const demoPassword = readSecretFile(demoFile, "demo"), apiKey = readSecretFile(apiFile, "key");
function cookie(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    if (line.startsWith("#HttpOnly_")) line = line.slice(10);
    if (!line || line.startsWith("#")) return [];
    const f = line.split("\t");
    return f.length >= 7 ? [`${f[5]}=${f[6]}`] : [];
  }).join("; ");
}
const demoCookie = cookie(demoJar), adminCookie = cookie(adminJar);
if (!/auth_token=/.test(demoCookie) || !/auth_token=/.test(adminCookie)) usage("auth_cookie_missing");
const secrets = [demoPassword, apiKey, demoCookie, adminCookie];
const redact = (value) => secrets.reduce((s, secret) => s.split(secret).join("[REDACTED]"), String(value));
async function request(method, pathname, { cookie: c, body, headers = {} } = {}) {
  const u = new URL(pathname, base), payload = body === undefined ? undefined : JSON.stringify(body);
  const h = { ...headers }; if (c) h.cookie = c; if (payload !== undefined) h["content-type"] = "application/json";
  if (h.host === undefined && h.Host === undefined) h.host = u.host;
  const lib = u.protocol === "https:" ? https : http;
  const { status, headers: rh, text } = await new Promise((resolve, reject) => {
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: `${u.pathname}${u.search}`, method, headers: h }, (res) => {
      const chunks = []; res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const headers = { get: (name) => { const k = Object.keys(res.headers).find((x) => x.toLowerCase() === String(name).toLowerCase()); const v = k ? res.headers[k] : undefined; return Array.isArray(v) ? v.join(", ") : (v ?? null); } };
        resolve({ status: res.statusCode, headers, text });
      });
    });
    req.on("error", reject); if (payload !== undefined) req.write(payload); req.end();
  });
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status, headers: rh, text, json };
}
const cases = [];
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const okKeys = (o, keys) => o && typeof o === "object" && Object.keys(o).sort().join() === [...keys].sort().join();
const exactStatsSchema = (j) => {
  const raw = JSON.stringify(j);
  if (/"((?:provider|model|connectionId|account|apiKey|byProvider|byModel|byAccount|byApiKey|byEndpoint|recentRequests|activeRequests|errorProvider|details|prompt|response|tunnel|proxy|url|key))"\s*:/i.test(raw)) return false;
  return okKeys(j, ["period","totals","series","last10Minutes"]) && okKeys(j.totals, ["requests","promptTokens","completionTokens","cachedTokens","cost"])
    && Array.isArray(j.series) && j.series.every((b) => okKeys(b, ["label","requests","tokens","cost"]))
    && Array.isArray(j.last10Minutes) && j.last10Minutes.every((b) => okKeys(b, ["requests","promptTokens","completionTokens","cost"]));
};
async function check(id, fn) {
  try { cases.push({ id, status: "PASS", evidence: await fn() }); }
  catch (error) { cases.push({ id, status: "FAIL", error: redact(error.message) }); }
}
const status = async (method, url, wanted, c, headers) => {
  const r = await request(method, url, { cookie: c, headers });
  expect(r.status === wanted, `http_${r.status}_expected_${wanted}`);
  if (wanted === 403) expect(r.json?.code === "demo_locked", "missing_demo_locked");
  return { httpStatus: r.status };
};
await check("C01", async () => {
  const r = await request("GET", "/api/settings/require-login");
  expect(r.status === 200 && r.json?.requireLogin === true && r.json?.tunnelDashboardAccess === false, "require_login");
  expect(Object.keys(r.json).every((k) => ["requireLogin", "tunnelDashboardAccess"].includes(k)), "leaked_key");
  return { httpStatus: 200 };
});
await check("C02", async () => {
  const r = await request("GET", "/api/settings");
  expect(r.status === 401 && r.json?.error === "Unauthorized", "unauthorized_body");
  return { httpStatus: 401 };
});
await check("C03", () => status("GET", "/api/keys", 401));
await check("C04", async () => {
  const r = await request("GET", "/dashboard/showroom");
  expect([302,303,307,308].includes(r.status) && /\/login/.test(r.headers.get("location") || ""), "login_redirect");
  return { httpStatus: r.status };
});
await check("C05", async () => {
  const login = await request("POST", "/api/auth/login", { body: { password: demoPassword } });
  const token = (login.headers.get("set-cookie") || "").match(/auth_token=([^;]+)/)?.[1];
  expect(login.status === 200 && login.json?.success && token, "demo_login");
  const auth = await request("GET", "/api/auth/status", { cookie: `auth_token=${token}` });
  expect(auth.json?.authenticated === true && auth.json?.role === "demo", "demo_role");
  return { httpStatus: 200, role: "demo" };
});
await check("C06", async () => {
  const r = await request("GET", "/api/demo/stats?period=7d", { cookie: demoCookie });
  const raw = JSON.stringify(r.json);
  expect(r.status === 200 && exactStatsSchema(r.json), "stats_schema");
  return { httpStatus: 200, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
});
for (const row of [
  ["C07","GET","/api/usage/stats?period=7d"],["C08","GET","/api/usage/chart"],["C09","GET","/api/usage/stream"],
  ["C10","GET","/api/usage/request-details"],["C11","GET","/api/usage/providers"],["C12","GET","/api/settings"],
  ["C13","PATCH","/api/settings"],["C14","GET","/api/keys"],["C15","POST","/api/keys"],["C16","GET","/api/providers"],
  ["C17","DELETE","/api/providers/x"],["C18","GET","/api/tunnel/status"],["C19","POST","/api/tunnel/enable"],
]) await check(row[0], () => status(row[1], row[2], 403, demoCookie));
for (const row of [["C20","/dashboard/usage"],["C21","/dashboard/quota"],["C22","/dashboard/endpoint"],["C23","/dashboard/providers"]]) {
  await check(row[0], async () => {
    const r = await request("GET", row[1], { cookie: demoCookie });
    expect(r.status === 303 && /\/dashboard\/showroom/.test(r.headers.get("location") || ""), "showroom_redirect");
    return { httpStatus: 303 };
  });
}
await check("C24", async () => {
  const file = path.join(browserDir, "c24-showroom.har"), raw = fs.readFileSync(file, "utf8"), entries = JSON.parse(raw).log.entries;
  const pathname = (e) => new URL(e.request.url).pathname, paths = entries.map(pathname);
  const allowed = ["/api/demo/stats","/api/auth/status","/api/settings/require-login","/api/version","/api/health","/api/init"];
  const apiOk = (p) => allowed.some((a) => p === a || p.startsWith(a + "?"));
  expect(entries.some((e) => pathname(e) === "/dashboard/showroom" && e.response.status === 200), "showroom_har_missing");
  expect(paths.some((p) => p === "/api/auth/status"), "auth_status_har_missing");
  expect(paths.some((p) => p === "/api/demo/stats" || p.startsWith("/api/demo/stats?")), "stats_har_missing");
  expect(!entries.some((e) => { const p = pathname(e); return p.startsWith("/api/") && !apiOk(p); }), "restricted_har_request");
  expect(!entries.some((e) => e.request.headers.some((h) => /^(cookie|authorization|x-api-key)$/i.test(h.name))), "har_not_redacted");
  return { httpStatus: 200, harSha256: crypto.createHash("sha256").update(raw).digest("hex") };
});
const remoteHeaders = args.mode === "local" ? { host: "remote.example" } : {};
await check("C25", () => status("GET", "/v1/models", 401, demoCookie, remoteHeaders));
await check("C26", () => status("GET", "/api/settings", 200, adminCookie));
await check("C27", () => status("GET", "/dashboard/usage", 200, adminCookie));
await check("C28", () => status("POST", "/api/usage/x/codex-reset-credits", 403, demoCookie));
await check("C29", () => status("GET", "/api/demo/stats", 401));
await check("C30", async () => {
  const r = await request("GET", "/dashboard/providers", { cookie: demoCookie, headers: { RSC: "1", "Next-Router-Prefetch": "1", accept: "text/x-component" } });
  expect(r.status === 404 && r.text === "", "rsc_not_empty_404");
  return { httpStatus: 404 };
});
for (const row of [["C31","GET","/api/translator/console-logs"],["C32","GET","/api/cli-tools/all-statuses"],["C33","POST","/api/shutdown"],["C34","POST","/api/version/shutdown"]]) {
  await check(row[0], () => status(row[1], row[2], 403, demoCookie, row[0] >= "C33" ? remoteHeaders : {}));
}
await check("C37", () => status("GET", "/v1/models", 200, null, { ...remoteHeaders, authorization: `Bearer ${apiKey}` }));
let hostRaw = "", host = null;
try { hostRaw = fs.readFileSync(hostFile, "utf8"); host = JSON.parse(hostRaw); } catch {}
for (const id of ["C35", "C36"]) await check(id, async () => {
  expect(host?.schema === "blabs-demo-lock-host-evidence-v1" && host.scope === args.mode, "host_schema");
  expect(host.cases?.map((c) => c.id).join(",") === "C35,C36", "host_id_set");
  expect(!secrets.some((secret) => hostRaw.includes(secret)), "host_contains_secret");
  const item = host.cases?.find((c) => c.id === id);
  expect(item?.status === "PASS" && item.exitCode !== 0 && item.everListened === false, "host_case");
  expect(item.reason === (id === "C35" ? "missing_password" : "demo_password_equals_admin"), "host_reason");
  return { exitCode: item.exitCode, everListened: false, reason: item.reason };
});
cases.sort((a, b) => a.id.localeCompare(b.id));
const orderOk = cases.map((c) => c.id).join(",") === IDS.join(",");
const pass = cases.filter((c) => c.status === "PASS").length;
const report = { schema: "blabs-demo-lock-audit-v1", mode: args.mode, base: base.origin, generatedAt: new Date().toISOString(), cases, summary: { pass, fail: cases.length - pass, skip: 0 }, ok: orderOk && pass === 37 };
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
