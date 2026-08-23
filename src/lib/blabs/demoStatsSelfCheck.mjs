import assert from "node:assert/strict";
import { toDemoStats, scanForbiddenKeys } from "./demoStats.js";

function test_to_demo_stats_strips_byProvider_byModel_byAccount_byApiKey() {
  const raw = {
    totalRequests: 3, totalPromptTokens: 10, totalCompletionTokens: 20, totalCachedTokens: 1, totalCost: 0.5,
    byProvider: { openai: { requests: 1 } }, byModel: { "gpt-4": { requests: 1 } },
    byAccount: { a1: { requests: 1 } }, byApiKey: { k1: { requests: 1 } }, byEndpoint: { "/v1": { requests: 1 } },
    last10Minutes: [{ requests: 1, promptTokens: 2, completionTokens: 3, cost: 0.1 }],
  };
  const out = toDemoStats("7d", raw, [{ label: "Jul 9", tokens: 30, cost: 0.5, requests: 3 }]);
  assert.equal(out.totals.requests, 3);
  for (const k of ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"]) assert.ok(!(k in out));
  assert.equal(JSON.stringify(out).includes("byProvider"), false);
}

function test_to_demo_stats_strips_recent_and_active_requests() {
  const raw = {
    totalRequests: 1, totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    recentRequests: [{ provider: "x" }], activeRequests: [{ provider: "x" }], errorProvider: "openai", last10Minutes: [],
  };
  const out = toDemoStats("24h", raw, []);
  for (const k of ["recentRequests", "activeRequests", "errorProvider"]) assert.ok(!(k in out));
  assert.equal(/recentRequests|activeRequests|errorProvider/i.test(JSON.stringify(out)), false);
}

function test_to_demo_stats_series_has_only_label_requests_tokens_cost() {
  const out = toDemoStats("7d", { totalRequests: 0, last10Minutes: [] }, [
    { label: "Jul 9", tokens: 5, cost: 0.1, requests: 2, provider: "leak", model: "m" },
  ]);
  assert.deepEqual(Object.keys(out.series[0]).sort(), ["cost", "label", "requests", "tokens"]);
  assert.equal(out.series[0].requests, 2);
  assert.equal(out.series[0].tokens, 5);
}

function test_forbidden_key_scan_rejects_provider_substring_in_values() {
  assert.equal(scanForbiddenKeys({ period: "7d", note: "my provider x" }), "value:provider");
  assert.throws(
    () => toDemoStats("7d", { totalRequests: 0, last10Minutes: [] }, [{ label: "provider-leak", tokens: 0, cost: 0, requests: 0 }]),
    /forbidden_demo_stats/,
  );
}

const tests = [
  test_to_demo_stats_strips_byProvider_byModel_byAccount_byApiKey,
  test_to_demo_stats_strips_recent_and_active_requests,
  test_to_demo_stats_series_has_only_label_requests_tokens_cost,
  test_forbidden_key_scan_rejects_provider_substring_in_values,
];
let passed = 0;
for (const t of tests) { t(); passed++; console.log(`PASS ${t.name}`); }
console.log(`demoStatsSelfCheck: ${passed}/${tests.length} PASS`);
