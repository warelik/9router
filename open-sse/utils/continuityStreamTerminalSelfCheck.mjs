import assert from "node:assert/strict";
import { FORMATS } from "../translator/formats.js";
import { isContinuityProtocolTerminal } from "./continuityStreamTerminal.js";

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check("isContinuityProtocolTerminal: accepts real protocol terminals and rejects incomplete Responses EOF/DONE", () => {
  assert.equal(isContinuityProtocolTerminal({ done: true }, { targetFormat: FORMATS.OPENAI }), true);
  assert.equal(isContinuityProtocolTerminal({ choices: [{ finish_reason: "stop" }] }), true);
  assert.equal(isContinuityProtocolTerminal({ type: "message_stop" }), true);
  assert.equal(isContinuityProtocolTerminal({ candidates: [{ finishReason: "STOP" }] }), true);
  assert.equal(isContinuityProtocolTerminal({ done: true }, { targetFormat: FORMATS.OLLAMA }), true);
  assert.equal(isContinuityProtocolTerminal({ type: "response.completed" }, { targetFormat: FORMATS.OPENAI_RESPONSES }), true);
  assert.equal(isContinuityProtocolTerminal({ type: "response.failed" }, { targetFormat: FORMATS.OPENAI_RESPONSES }), true);

  assert.equal(isContinuityProtocolTerminal({ done: true }, { targetFormat: FORMATS.OPENAI_RESPONSES }), false);
  assert.equal(isContinuityProtocolTerminal({ done: true }, { sawOpenAIResponsesEvent: true }), false);
  assert.equal(isContinuityProtocolTerminal({ choices: [{ delta: { content: "partial" } }] }), false);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exit(1);
