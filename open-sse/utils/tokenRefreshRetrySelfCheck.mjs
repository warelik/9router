import assert from "node:assert/strict";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { classifyOAuthRefreshError } from "../services/tokenRefresh/providers.js";

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("classifyOAuthRefreshError marks invalid_grant as permanent", () => {
  const result = classifyOAuthRefreshError(JSON.stringify({
    error: "invalid_grant",
    error_description: "Refresh token expired"
  }), 400);
  assert.equal(result.permanent, true);
  assert.equal(result.code, "invalid_grant");
});

check("refreshWithRetry stops immediately on unrecoverable refresh result", async () => {
  let calls = 0;
  const result = await refreshWithRetry(async () => {
    calls += 1;
    return { error: "unrecoverable_refresh_error", code: "invalid_grant" };
  }, { maxRetries: 3, retryDelayMs: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(result, { error: "unrecoverable_refresh_error", code: "invalid_grant" });
});

check("refreshWithRetry honors fast-switch one-attempt policy", async () => {
  let calls = 0;
  const result = await refreshWithRetry(async () => {
    calls += 1;
    return null;
  }, { maxRetries: 1, retryDelayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(result, null);
});

check("refreshWithRetry still retries transient null results when configured", async () => {
  let calls = 0;
  const result = await refreshWithRetry(async () => {
    calls += 1;
    return calls === 2 ? { accessToken: "ok" } : null;
  }, { maxRetries: 3, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.deepEqual(result, { accessToken: "ok" });
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exit(1);
