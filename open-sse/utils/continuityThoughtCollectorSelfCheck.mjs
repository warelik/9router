import assert from "node:assert/strict";
import { collectResponseThoughts, budgetThoughts, filterOversizeThoughts, createStreamingThoughtAccumulator } from "./continuityThoughtCollector.js";

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check("collectResponseThoughts: extracts thoughts across known vendor formats", () => {
  // OpenAI structure
  const openaiResp = {
    choices: [{
      message: {
        content: "hello",
        reasoning_content: "openai reasoning"
      }
    }]
  };
  const oThoughts = collectResponseThoughts(openaiResp, "openai");
  assert.equal(oThoughts.length, 1);
  assert.equal(oThoughts[0].text, "openai reasoning");

  // Claude structure
  const claudeResp = {
    content: [
      { type: "thinking", thinking: "claude thought" },
      { type: "text", text: "visible output" }
    ]
  };
  const cThoughts = collectResponseThoughts(claudeResp, "claude");
  assert.equal(cThoughts.length, 1);
  assert.equal(cThoughts[0].text, "claude thought");

  // Gemini structure
  const geminiResp = {
    candidates: [{
      content: {
        parts: [
          { text: "gemini thoughts", thought: true },
          { text: "visible" }
        ]
      }
    }]
  };
  const gThoughts = collectResponseThoughts(geminiResp, "antigravity");
  assert.equal(gThoughts.length, 1);
  assert.equal(gThoughts[0].text, "gemini thoughts");
});

check("collectResponseThoughts: does not pick up reasoning-shaped fields nested in unrelated payload (Responses reasoning item)", () => {
  const responsesResp = {
    output: [
      { type: "reasoning", summary: [{ text: "responses reasoning" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] }
    ]
  };
  const rThoughts = collectResponseThoughts(responsesResp, "openai-responses");
  assert.equal(rThoughts.length, 1);
  assert.equal(rThoughts[0].text, "responses reasoning");

  // A "thinking"-named field buried inside an unrelated nested object (e.g. a tool
  // result payload the model echoed back) must NOT be picked up as a model thought —
  // explicit adapters only ever read from their own known response shape.
  const decoyResp = {
    choices: [{
      message: {
        content: "visible answer",
        tool_calls: [{ function: { name: "x", arguments: JSON.stringify({ thinking: "not a real thought" }) } }]
      }
    }]
  };
  const decoyThoughts = collectResponseThoughts(decoyResp, "openai");
  assert.equal(decoyThoughts.length, 0);
});

check("collectResponseThoughts: extracts OpenAI-compatible message.thinking without dedupe", () => {
  const thoughts = collectResponseThoughts({
    choices: [{
      message: {
        thinking: "internal thought"
      }
    }]
  }, "openai");
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0].text, "internal thought");

  const bothFields = collectResponseThoughts({
    choices: [{
      message: {
        reasoning_content: "same",
        thinking: "same"
      }
    }]
  }, "openai");
  assert.equal(bothFields.length, 2);
  assert.deepEqual(bothFields.map(t => t.text), ["same", "same"]);
});

check("budgetThoughts: chronologically packs thoughts under character cap", () => {
  const thoughts = ["t1-short", "t2-very-long-exceeds-limit", "t3-short"];

  // Budget is small (e.g. 20 chars max).
  // We process backward: "t3-short" (8 chars, fits) -> "t2-very-long" (26 chars, doesn't fit, breaks).
  // Chronological output should be ["t3-short"]
  const budgeted = budgetThoughts(thoughts, 3, 20);
  assert.equal(budgeted.length, 1);
  assert.equal(budgeted[0], "t3-short");
});

check("filterOversizeThoughts: drops oversize records with a warning, keeps the rest, no dedupe", () => {
  const big = "x".repeat(50);
  const kept = filterOversizeThoughts(["dup", "dup", big], 10);
  assert.deepEqual(kept, ["dup", "dup"]);
});

check("createStreamingThoughtAccumulator: Claude content_block boundaries split distinct thinking segments", () => {
  const acc = createStreamingThoughtAccumulator();
  acc.push({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  acc.push({ type: "content_block_delta", index: 0, delta: { thinking: "first " } });
  acc.push({ type: "content_block_delta", index: 0, delta: { thinking: "block" } });
  acc.push({ type: "content_block_stop", index: 0 });
  acc.push({ type: "content_block_start", index: 1, content_block: { type: "text" } });
  acc.push({ type: "content_block_start", index: 2, content_block: { type: "thinking" } });
  acc.push({ type: "content_block_delta", index: 2, delta: { thinking: "second block" } });
  acc.push({ type: "content_block_stop", index: 2 });

  const segments = acc.finalize();
  assert.deepEqual(segments, ["first block", "second block"]);
});

check("createStreamingThoughtAccumulator: OpenAI/Gemini/Ollama shapes collapse into one segment per turn", () => {
  const acc = createStreamingThoughtAccumulator();
  acc.push({ choices: [{ delta: { reasoning_content: "step 1 " } }] });
  acc.push({ choices: [{ delta: { thinking: "step 2 " } }] });
  acc.push({ choices: [{ delta: { reasoning_content: "step 3" } }] });
  assert.deepEqual(acc.finalize(), ["step 1 step 2 step 3"]);
});

check("createStreamingThoughtAccumulator: native Antigravity passthrough response.candidates wrapper is captured", () => {
  const acc = createStreamingThoughtAccumulator();
  acc.push({
    response: {
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "native reasoning" },
            { text: "visible answer" }
          ]
        }
      }]
    }
  });
  assert.deepEqual(acc.finalize(), ["native reasoning"]);
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
