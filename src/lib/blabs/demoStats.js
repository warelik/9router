/** Project raw usage/chart into demo showroom schema. Never return raw. */
const PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);
export const FORBIDDEN_DEMO_STATS_KEYS = Object.freeze([
  "provider", "model", "connectionId", "account", "apiKey",
  "byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint",
  "recentRequests", "activeRequests", "errorProvider", "details",
  "prompt", "response", "tunnel", "proxy", "url", "key",
]);
const FORBIDDEN = new Set(FORBIDDEN_DEMO_STATS_KEYS);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** @returns {string|null} */
export function scanForbiddenKeys(node) {
  if (node == null) return null;
  if (typeof node === "string") {
    const lower = node.toLowerCase();
    for (const k of FORBIDDEN_DEMO_STATS_KEYS) if (lower.includes(k.toLowerCase())) return `value:${k}`;
    return null;
  }
  if (typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = scanForbiddenKeys(item); if (hit) return hit; }
    return null;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN.has(k)) return `key:${k}`;
    const hit = scanForbiddenKeys(v);
    if (hit) return hit;
  }
  return null;
}

export function toDemoStats(period, usageStats, chartBuckets) {
  const p = PERIODS.has(period) ? period : "7d";
  const u = usageStats && typeof usageStats === "object" ? usageStats : {};
  const buckets = Array.isArray(chartBuckets) ? chartBuckets : [];
  const last = Array.isArray(u.last10Minutes) ? u.last10Minutes : [];
  const out = {
    period: p,
    totals: {
      requests: num(u.totalRequests), promptTokens: num(u.totalPromptTokens),
      completionTokens: num(u.totalCompletionTokens), cachedTokens: num(u.totalCachedTokens),
      cost: num(u.totalCost),
    },
    series: buckets.map((b) => ({
      label: String(b?.label ?? ""), requests: num(b?.requests), tokens: num(b?.tokens), cost: num(b?.cost),
    })),
    last10Minutes: last.map((m) => ({
      requests: num(m?.requests), promptTokens: num(m?.promptTokens),
      completionTokens: num(m?.completionTokens), cost: num(m?.cost),
    })),
  };
  const hit = scanForbiddenKeys(out);
  if (hit) throw new Error(`forbidden_demo_stats:${hit}`);
  return out;
}
