import assert from "node:assert/strict";
import { canonicalizeIncomingHistory, deriveContinuityScopeId } from "./continuityCanonicalizer.js";
import { collectProviderResponseThoughts, finalizeContinuityJsonResult } from "./continuityJsonResponse.js";
import { FORMATS } from "../translator/formats.js";

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check("collectProviderResponseThoughts: JSON provider response", async () => {
  const response = new Response(JSON.stringify({
    choices: [{ message: { reasoning_content: "reasoning-json", content: "answer" } }]
  }));
  assert.deepEqual(await collectProviderResponseThoughts(response), ["reasoning-json"]);
});

check("collectProviderResponseThoughts: SSE deltas collapse into one ordered segment", async () => {
  const response = new Response([
    'data: {"choices":[{"delta":{"reasoning_content":"first "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"second"}}]}',
    "data: [DONE]",
    ""
  ].join("\n"));
  assert.deepEqual(await collectProviderResponseThoughts(response), ["first second"]);
});

check("finalizeContinuityJsonResult: hashes normalized client body and preserves successful response", async () => {
  const infoLines = [];
  const log = { info: (_tag, line) => infoLines.push(line), debug: () => {}, warn: () => {} };
  const sourceFormat = FORMATS.OPENAI;
  const scopeId = deriveContinuityScopeId("json-self-check-key");
  const incomingEvents = canonicalizeIncomingHistory({
    messages: [{ role: "user", content: "question" }]
  }, sourceFormat);
  const result = {
    success: true,
    response: new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "<think>visible</think> answer" }, finish_reason: "stop" }]
    }), { headers: { "content-type": "application/json", "content-length": "999" } })
  };

  const finalized = await finalizeContinuityJsonResult({
    result,
    continuityCtx: {
      scopeId,
      incomingEvents,
      resolvedState: null,
      continuityCount: 7,
      responseSource: "json",
      requestLogToken: "jsoncheck",
      log
    },
    responseThoughtsPromise: Promise.resolve(["captured reasoning"]),
    sourceFormat
  });

  assert.equal(finalized, result);
  assert.equal(finalized.response.headers.has("content-length"), false);
  const body = await finalized.response.json();
  assert.equal(body.choices[0].message.content, "visible answer");
  assert.ok(infoLines.some((line) => line.includes("[STORE]")));
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exit(1);
