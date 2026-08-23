#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const phase = process.argv[2];
const rawArgs = process.argv.slice(3);
const allowedOptions = new Set(["--mode", "--base", "--evidence-dir", "--cookie-env", "--expected-rebrand"]);
const options = new Map();
if (phase !== "precheck" && phase !== "finalize") {
  console.error("STOP: phase must be precheck or finalize");
  process.exit(2);
}
if (rawArgs.length % 2 !== 0) {
  console.error("STOP: every D005 option requires one value");
  process.exit(2);
}
for (let index = 0; index < rawArgs.length; index += 2) {
  const name = rawArgs[index];
  const value = rawArgs[index + 1];
  if (!allowedOptions.has(name) || options.has(name) || !value) {
    console.error(`STOP: invalid or duplicate D005 option ${name}`);
    process.exit(2);
  }
  options.set(name, value);
}
for (const name of allowedOptions) {
  if (!options.has(name)) {
    console.error(`STOP: missing ${name}`);
    process.exit(2);
  }
}
const mode = options.get("--mode");
if (mode !== "local" && mode !== "remote") {
  console.error("STOP: --mode must be local or remote");
  process.exit(2);
}
const evidenceDir = options.get("--evidence-dir");
const cookieEnv = options.get("--cookie-env");
const expectedRebrand = options.get("--expected-rebrand");
let baseUrl;
try {
  baseUrl = new URL(options.get("--base"));
} catch {
  console.error("STOP: --base is not a URL");
  process.exit(2);
}
const remoteHost = baseUrl.hostname.toLowerCase();
const remoteLabels = remoteHost.split(".");
const baseOk = !(baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) && (
  mode === "local"
    ? baseUrl.protocol === "http:" && baseUrl.hostname === "127.0.0.1" && !!baseUrl.port && baseUrl.port !== "0"
    : baseUrl.protocol === "https:" && !baseUrl.port && remoteLabels.length === 3 &&
      remoteLabels[1] === "trycloudflare" && remoteLabels[2] === "com" &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(remoteLabels[0])
);
if (!baseOk) {
  console.error(mode === "local"
    ? "STOP: --base local mode requires http://127.0.0.1:<port>"
    : "STOP: --base remote mode requires https://<single-label>.trycloudflare.com");
  process.exit(2);
}
const base = baseUrl.origin;
if (!path.isAbsolute(evidenceDir)) {
  console.error("STOP: --evidence-dir must be absolute");
  process.exit(2);
}
const evidenceRoot = "/Users/warelik/Developer/9router-telepathy2/artifacts/blabs";
const evidenceRelative = path.relative(evidenceRoot, evidenceDir);
if (evidenceRelative.startsWith("..") || path.isAbsolute(evidenceRelative)) {
  console.error("STOP: --evidence-dir must be below artifacts/blabs");
  process.exit(2);
}
if (cookieEnv !== "BLABS_AUDIT_COOKIE") {
  console.error("STOP: --cookie-env must equal BLABS_AUDIT_COOKIE");
  process.exit(2);
}
const cookie = process.env[cookieEnv];
const expectRebrand = expectedRebrand === "1";
const forbiddenVisible = [
  /decolua/i,
  /buymeacoffee/i,
  /ko-fi/i,
  /9router\.com\/api\/donate/i,
  /9remote\.cc/i,
  /mailto:/i,
  /contact@/i,
  /support@/i,
  /npx 9router/i,
  /support 9router/i,
  /contact us/i,
  /change log/i,
  /(^|[^\w-])9router([^\w-]|$)/i,
];
const forbiddenUrl = /decolua|buymeacoffee|ko-fi|9router\.com\/api\/donate|9remote\.cc|mailto:|contact@|support@|\/api\/version(?:$|[/?#])/i;

function reportAndExit(code, message, extra = {}) {
  const report = Object.assign({
    schema: "blabs-d005-command-result-v2",
    ok: false,
    gatePass: false,
    stop: code === 2,
    phase,
    error: message,
  }, extra);
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

if (!cookie || !cookie.startsWith("auth_token=") || cookie.length <= "auth_token=".length) {
  reportAndExit(2, "BLABS_AUDIT_COOKIE missing or malformed");
}
if (cookie.includes(";") || /[\r\n]/.test(cookie)) reportAndExit(2, "BLABS_AUDIT_COOKIE must be one auth_token pair");
if (!expectRebrand) reportAndExit(2, "--expected-rebrand must equal 1");
fs.mkdirSync(evidenceDir, { recursive: true });

function stripScriptsStyles(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}

function visibleFailures(label, text) {
  const failures = [];
  for (const expression of forbiddenVisible) {
    if (expression.test(text)) failures.push(`${label} matched ${expression}`);
  }
  return failures;
}

async function get(label, urlPath, authenticated) {
  const headers = authenticated ? { Cookie: cookie } : {};
  const response = await fetch(new URL(urlPath, base), { headers, redirect: "manual", cache: "no-store" });
  return {
    label,
    path: urlPath,
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type") || "",
    body: await response.text(),
  };
}

if (phase === "precheck") {
  const captures = [
    await get("landing", "/landing", false),
    await get("login", "/login", false),
    await get("manifest", "/manifest.webmanifest", false),
    await get("dashboard-authenticated", "/dashboard/usage", true),
    await get("dashboard-anonymous", "/dashboard/usage", false),
  ];
  const failures = [];
  for (const capture of captures) {
    if (capture.label === "dashboard-anonymous") continue;
    if (capture.status < 200 || capture.status >= 300) failures.push(`${capture.label} status ${capture.status}`);
    const body = capture.contentType.includes("text/html") ? stripScriptsStyles(capture.body) : capture.body;
    failures.push(...visibleFailures(`raw ${capture.label}`, body));
    const urls = Array.from(body.matchAll(/\b(?:href|src|action)=["']([^"']+)["']/gi), (match) => match[1]);
    for (const url of urls) {
      if (forbiddenUrl.test(url)) failures.push(`raw ${capture.label} URL ${url}`);
    }
  }
  const dashboard = captures.find((capture) => capture.label === "dashboard-authenticated");
  const anonymous = captures.find((capture) => capture.label === "dashboard-anonymous");
  if (![307, 308].includes(anonymous.status) || !String(anonymous.location).endsWith("/login")) {
    reportAndExit(2, "anonymous dashboard did not redirect to login", {
      anonymousStatus: anonymous.status,
      anonymousLocation: anonymous.location,
    });
  }
  if (/Enter your password to access the dashboard/.test(dashboard.body)) {
    reportAndExit(2, "dashboard returned login shell");
  }
  if (!/<header\b/i.test(dashboard.body)) reportAndExit(2, "raw dashboard lacks Header");
  if (!/<aside\b/i.test(dashboard.body)) reportAndExit(2, "raw dashboard lacks Sidebar");
  if (!/Endpoint &(?:amp;)? Key/.test(dashboard.body)) reportAndExit(2, "raw dashboard lacks Sidebar marker");
  if (!/data-blabs-rebrand=["']1["']/.test(dashboard.body)) failures.push("raw dashboard lacks rebrand attribute");
  if (!/BLabsAIGate/.test(dashboard.body)) failures.push("raw dashboard lacks BLabsAIGate");
  const manifestCapture = captures.find((capture) => capture.label === "manifest");
  let manifest;
  try {
    manifest = JSON.parse(manifestCapture.body);
  } catch {
    reportAndExit(2, "manifest response is not JSON");
  }
  if (manifest.name !== "BLabsAIGate - AI Infrastructure Management" || manifest.short_name !== "BLabsAIGate") {
    failures.push("manifest brand mismatch");
  }
  const raw = {
    schema: "blabs-d005-raw-precheck-v2",
    ok: failures.length === 0,
    gatePass: false,
    stop: false,
    phase: "precheck",
    mode,
    base,
    expectedRebrand: true,
    authProof: {
      cookieName: "auth_token",
      cookiePresent: true,
      withCookieStatus: dashboard.status,
      withoutCookieStatus: anonymous.status,
      withoutCookieLocation: anonymous.location,
    },
    failures,
    captures: captures.map((capture) => ({
      label: capture.label,
      path: capture.path,
      status: capture.status,
      location: capture.location,
      contentType: capture.contentType,
      bodyLength: capture.body.length,
      bodySha256: crypto.createHash("sha256").update(capture.body).digest("hex"),
    })),
  };
  fs.writeFileSync(path.join(evidenceDir, "raw-precheck.json"), `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(raw, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

const required = [
  "raw-precheck.json",
  "browser-evidence.json",
  "gate-b.har",
  "dashboard.png",
  "header.png",
  "sidebar.png",
];
for (const name of required) {
  const absolute = path.join(evidenceDir, name);
  if (!fs.existsSync(absolute)) reportAndExit(2, `browser artifact missing: ${name}`);
  if (fs.statSync(absolute).size === 0) reportAndExit(2, `browser artifact empty: ${name}`);
}
for (const name of ["dashboard.png", "header.png", "sidebar.png"]) {
  if (fs.statSync(path.join(evidenceDir, name)).size < 1024) reportAndExit(2, `screenshot too small: ${name}`);
}

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(evidenceDir, name), "utf8"));
  } catch (error) {
    reportAndExit(2, `invalid JSON artifact ${name}: ${error.message}`);
  }
}
const raw = readJson("raw-precheck.json");
const browser = readJson("browser-evidence.json");
const har = readJson("gate-b.har");
const cookieValue = cookie.slice("auth_token=".length);
if (JSON.stringify(browser).includes(cookieValue) || JSON.stringify(har).includes(cookieValue)) {
  reportAndExit(2, "browser evidence contains auth token");
}
if (raw.schema !== "blabs-d005-raw-precheck-v2" || raw.ok !== true || raw.gatePass !== false) {
  reportAndExit(2, "raw precheck contract invalid");
}
if (raw.mode !== mode || raw.base !== base) reportAndExit(2, "raw precheck mode/base mismatch");
if (browser.schema !== "blabs-d005-browser-evidence-v2") reportAndExit(2, "browser schema invalid");
if (browser.mechanism !== "playwright-cdp") reportAndExit(2, "wrong browser mechanism");
if (browser.mode !== mode) reportAndExit(2, "browser mode mismatch");
if (browser.base !== base) reportAndExit(2, "browser base mismatch");
if (browser.path !== "/dashboard/usage") reportAndExit(2, "browser path mismatch");
if (browser.expectedRebrand !== true) reportAndExit(2, "browser expected-rebrand mismatch");
if (
  browser.playwright?.module !== "/Users/warelik/.local/share/mise/installs/node/24.14.1/lib/node_modules/playwright" ||
  browser.playwright?.version !== "1.60.0" ||
  browser.playwright?.channel !== "chrome" ||
  typeof browser.playwright?.browserVersion !== "string" ||
  browser.playwright.browserVersion.length === 0
) {
  reportAndExit(2, "Playwright mechanism proof invalid");
}
if (browser.hydrated !== true || browser.hydrationInteraction !== true || browser.themeRestored !== true) {
  reportAndExit(2, "hydration proof missing");
}
if (browser.authenticated !== true) reportAndExit(2, "browser session not authenticated");
if (browser.authProof?.withCookieStatus !== 200) reportAndExit(2, "authenticated dashboard fetch failed");
if (browser.authProof?.withCookieHasShell !== true) reportAndExit(2, "authenticated dashboard response lacks shell");
if (![307, 308].includes(browser.authProof?.withoutCookieStatus)) {
  reportAndExit(2, "anonymous dashboard did not redirect");
}
if (browser.authProof?.withoutCookieFinalPath !== "/login") reportAndExit(2, "anonymous browser did not finish on login");
if (browser.dom.headerPresent !== true) reportAndExit(2, "hydrated Header missing");
if (browser.dom.sidebarPresent !== true) reportAndExit(2, "hydrated Sidebar missing");
if (!browser.dom.headerText.includes("Usage & Analytics")) reportAndExit(2, "hydrated Header marker missing");
if (!browser.dom.sidebarText.includes("Endpoint & Key")) reportAndExit(2, "hydrated Sidebar marker missing");
if (browser.dom.donatePresent !== false) reportAndExit(1, "Donate present in hydrated Header");
if (browser.dom.changeLogPresent !== false) reportAndExit(1, "Change Log present in hydrated DOM");
if (browser.dom.remotePresent !== false) reportAndExit(1, "Remote present in hydrated Sidebar");
if (browser.dom.headerMenuOpened !== true) reportAndExit(2, "HeaderMenu was not opened");
if (browser.dom.changeLogMenuCount !== 0) reportAndExit(1, "Change Log present in opened HeaderMenu");
if (browser.dom.donateTriggerCount !== 0) reportAndExit(1, "Donate trigger present");
if (browser.dom.remoteTriggerCount !== 0) reportAndExit(1, "Remote trigger present");
if (browser.dom.dialogCount !== 0) reportAndExit(1, "unexpected modal dialog present");
if (browser.dom.donateModalCount !== 0) reportAndExit(1, "Donate modal present");
if (browser.dom.changeLogModalCount !== 0) reportAndExit(1, "Change Log modal present");
if (browser.dom.remoteModalCount !== 0) reportAndExit(1, "Remote modal present");
if (browser.dom.rebrandAttribute !== "1") reportAndExit(1, "rebrand html attribute missing");
if (!browser.dom.visibleText.includes("BLabsAIGate")) reportAndExit(1, "BLabsAIGate missing from hydrated DOM");
if (!browser.dom.visibleText.includes("Endpoint & Key")) reportAndExit(2, "Sidebar marker missing after hydration");

const failures = [];
failures.push(...visibleFailures("browser title", browser.dom.title));
failures.push(...visibleFailures("browser visibleText", browser.dom.visibleText));
failures.push(...visibleFailures("opened HeaderMenu", browser.dom.headerMenuText));
for (const url of browser.dom.links) {
  if (forbiddenUrl.test(url)) failures.push(`browser DOM URL ${url}`);
}
const network = browser.network;
if (
  network?.enabledBeforeNavigation?.authenticated !== true ||
  network?.enabledBeforeNavigation?.anonymous !== true
) {
  reportAndExit(2, "Network.enable-before-navigation proof missing");
}
for (const eventName of ["requestWillBeSent", "responseReceived", "loadingFinished", "getResponseBody"]) {
  if (!Array.isArray(network.events?.[eventName]) || network.events[eventName].length === 0) {
    reportAndExit(2, `CDP event evidence empty: ${eventName}`);
  }
}
if (!Array.isArray(network.requests) || network.requests.length === 0) reportAndExit(2, "browser request evidence empty");
if (!Array.isArray(network.responses) || network.responses.length === 0) reportAndExit(2, "browser response evidence empty");
if (!Array.isArray(network.redirects) || network.redirects.length === 0) reportAndExit(2, "browser redirect evidence empty");
for (const request of network.requests) {
  if (forbiddenUrl.test(request.url)) failures.push(`browser request URL ${request.url}`);
}
for (const response of network.responses) {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    reportAndExit(2, `non-real browser response status ${response.status}`);
  }
  if (forbiddenUrl.test(response.url)) failures.push(`browser response URL ${response.url}`);
  if (response.bodyCaptured === true) {
    const decoded = response.base64Encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body;
    const pathname = new URL(response.url).pathname;
    if (
      response.mimeType.includes("text/html") ||
      response.mimeType.includes("manifest+json") ||
      pathname === "/manifest.webmanifest"
    ) {
      const responseText = response.mimeType.includes("text/html") ? stripScriptsStyles(decoded) : decoded;
      failures.push(...visibleFailures(`browser response ${response.url}`, responseText));
    }
  }
}
const dashboardBody = network.responses.find((response) => (
  response.context === "authenticated" &&
  new URL(response.url).pathname === "/dashboard/usage" &&
  response.type === "Document" &&
  response.status === 200 &&
  response.bodyCaptured === true &&
  response.body.length > 0
));
if (!dashboardBody) reportAndExit(2, "dashboard CDP response body missing");
if (har.log?.version !== "1.2") reportAndExit(2, "HAR version invalid");
if (har.log?.creator?.name !== "Playwright" || har.log?.creator?.version !== "1.60.0") {
  reportAndExit(2, "HAR creator invalid");
}
if (!Array.isArray(har.log?.entries) || har.log.entries.length === 0) reportAndExit(2, "HAR entries empty");
for (const entry of har.log.entries) {
  if (!Number.isInteger(entry.response?.status) || entry.response.status < 100 || entry.response.status > 599) {
    reportAndExit(2, `HAR contains non-real status ${entry.response?.status}`);
  }
  if (forbiddenUrl.test(entry.request?.url || "")) failures.push(`HAR request URL ${entry.request.url}`);
}
const dashboardHar = har.log.entries.find((entry) => (
  new URL(entry.request.url).pathname === "/dashboard/usage" &&
  entry.response.status === 200 &&
  typeof entry.response.content?.text === "string" &&
  entry.response.content.text.length > 0
));
if (!dashboardHar) reportAndExit(2, "HAR dashboard response body missing");

const finalReport = {
  schema: "blabs-d005-gate-report-v2",
  ok: failures.length === 0,
  gatePass: failures.length === 0,
  stop: false,
  phase: "finalize",
  mode,
  base,
  cookiePresent: true,
  mechanism: browser.mechanism,
  authenticated: browser.authenticated,
  authProof: browser.authProof,
  hydrated: browser.hydrated,
  networkProof: {
    requestWillBeSent: network.events.requestWillBeSent.length,
    responseReceived: network.events.responseReceived.length,
    redirects: network.redirects.length,
    getResponseBody: network.events.getResponseBody.length,
    harEntries: har.log.entries.length,
  },
  shellProven: { header: true, sidebar: true, donateChecked: true },
  artifacts: required.map((name) => {
    const bytes = fs.readFileSync(path.join(evidenceDir, name));
    return {
      name,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }),
  failures,
};
fs.writeFileSync(path.join(evidenceDir, "gate-b-report.json"), `${JSON.stringify(finalReport, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(finalReport, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
