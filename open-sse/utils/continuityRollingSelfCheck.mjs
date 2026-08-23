import assert from "node:assert/strict";
import {
  deriveContinuityScopeId,
  canonicalizeIncomingHistory,
  canonicalizeClientOutput,
  buildCompletedPairs,
  buildPairWindow,
  createClientOutputAccumulator
} from "./continuityCanonicalizer.js";
import {
  resolveContinuityState,
  commitContinuityState,
  commitContinuityFromClientOutput,
  clearContinuityStateForTests
} from "./continuityStore.js";
import { collectResponseThoughts, createStreamingThoughtAccumulator } from "./continuityThoughtCollector.js";

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check("End-to-End Simulation: Two parallel independent conversational branches", () => {
  clearContinuityStateForTests();
  const apiKey = "user-secret-api-key";
  const scopeId = deriveContinuityScopeId(apiKey);

  // --- CONVERSATION A ---
  // Step A1: User asks user-A1
  const bodyA1 = { messages: [{ role: "user", content: "user-A1" }] };
  const incomingEventsA1 = canonicalizeIncomingHistory(bodyA1, "openai");
  const pairsA1 = buildCompletedPairs(incomingEventsA1, scopeId);

  // Resolve State: should be null (first turn)
  const resolvedA1 = resolveContinuityState({ scopeId, completedPairHashes: pairsA1 });
  assert.equal(resolvedA1, null);

  // Assistant outputs response-A1
  const responseA1 = {
    choices: [{
      message: {
        content: "response-A1",
        reasoning_content: "thought-A1"
      }
    }]
  };
  const thoughtsA1 = collectResponseThoughts(responseA1, "openai");
  const clientOutA1 = canonicalizeClientOutput(responseA1, "openai");
  const historyA1 = [...incomingEventsA1, ...clientOutA1];
  const finalPairsA1 = buildCompletedPairs(historyA1, scopeId);

  // Commit Step A1
  const stateA1 = commitContinuityState({
    scopeId,
    parentState: resolvedA1,
    responseThoughts: thoughtsA1.map(t => t.text),
    finalPairWindow: buildPairWindow(finalPairsA1),
    continuityCount: 3
  });
  assert.ok(stateA1);

  // --- CONVERSATION B ---
  // Step B1: Parallel thread on same API key
  const bodyB1 = { messages: [{ role: "user", content: "user-B1" }] };
  const incomingEventsB1 = canonicalizeIncomingHistory(bodyB1, "openai");
  const pairsB1 = buildCompletedPairs(incomingEventsB1, scopeId);

  // Resolve State: first turn for thread B
  const resolvedB1 = resolveContinuityState({ scopeId, completedPairHashes: pairsB1 });
  assert.equal(resolvedB1, null);

  const responseB1 = {
    choices: [{
      message: {
        content: "response-B1",
        reasoning_content: "thought-B1"
      }
    }]
  };
  const thoughtsB1 = collectResponseThoughts(responseB1, "openai");
  const clientOutB1 = canonicalizeClientOutput(responseB1, "openai");
  const historyB1 = [...incomingEventsB1, ...clientOutB1];
  const finalPairsB1 = buildCompletedPairs(historyB1, scopeId);

  const stateB1 = commitContinuityState({
    scopeId,
    parentState: resolvedB1,
    responseThoughts: thoughtsB1.map(t => t.text),
    finalPairWindow: buildPairWindow(finalPairsB1),
    continuityCount: 3
  });
  assert.ok(stateB1);

  // --- RESOLVE CONVERSATION A TURN 2 ---
  const bodyA2 = {
    messages: [
      { role: "user", content: "user-A1" },
      { role: "assistant", content: "response-A1" },
      { role: "user", content: "user-A2" }
    ]
  };
  const incomingEventsA2 = canonicalizeIncomingHistory(bodyA2, "openai");
  const pairsA2 = buildCompletedPairs(incomingEventsA2, scopeId);

  const resolvedA2 = resolveContinuityState({ scopeId, completedPairHashes: pairsA2 });
  assert.ok(resolvedA2);
  assert.equal(resolvedA2.stateId, stateA1.stateId);
  assert.deepEqual([...resolvedA2.thoughts], ["thought-A1"]);

  // --- RESOLVE CONVERSATION B TURN 2 ---
  const bodyB2 = {
    messages: [
      { role: "user", content: "user-B1" },
      { role: "assistant", content: "response-B1" },
      { role: "user", content: "user-B2" }
    ]
  };
  const incomingEventsB2 = canonicalizeIncomingHistory(bodyB2, "openai");
  const pairsB2 = buildCompletedPairs(incomingEventsB2, scopeId);

  const resolvedB2 = resolveContinuityState({ scopeId, completedPairHashes: pairsB2 });
  assert.ok(resolvedB2);
  assert.equal(resolvedB2.stateId, stateB1.stateId);
  assert.deepEqual([...resolvedB2.thoughts], ["thought-B1"]);

  clearContinuityStateForTests();
  const antigravityScopeId = deriveContinuityScopeId("antigravity-key");
  const systemInstruction = { parts: [{ text: "system ctx" }] };
  const bodyAg2 = {
    userAgent: "antigravity",
    request: {
      systemInstruction,
      contents: [
        { role: "user", parts: [{ text: "A1" }] },
        { role: "model", parts: [{ text: "O1" }] },
        { role: "user", parts: [{ text: "A2" }] }
      ]
    }
  };
  const incomingAg2 = canonicalizeIncomingHistory(bodyAg2, "antigravity");
  assert.equal(buildCompletedPairs(incomingAg2, antigravityScopeId).length, 1);
  const stateAg2 = commitContinuityFromClientOutput({
    continuityCtx: {
      scopeId: antigravityScopeId,
      incomingEvents: incomingAg2,
      resolvedState: resolveContinuityState({
        scopeId: antigravityScopeId,
        completedPairHashes: buildCompletedPairs(incomingAg2, antigravityScopeId)
      }),
      continuityCount: 5
    },
    responseThoughts: ["thought-O2"],
    clientOutputEvents: canonicalizeClientOutput({
      response: { candidates: [{ content: { role: "model", parts: [{ text: "O2" }] } }] }
    }, "antigravity")
  });
  assert.ok(stateAg2);

  const bodyAg3 = {
    userAgent: "antigravity",
    request: {
      systemInstruction,
      contents: [
        { role: "user", parts: [{ text: "A1" }] },
        { role: "model", parts: [{ text: "O1" }] },
        { role: "user", parts: [{ text: "A2" }] },
        { role: "model", parts: [{ text: "O2" }] },
        { role: "user", parts: [{ text: "A3" }] }
      ]
    }
  };
  const incomingAg3 = canonicalizeIncomingHistory(bodyAg3, "antigravity");
  const resolvedAg3 = resolveContinuityState({
    scopeId: antigravityScopeId,
    completedPairHashes: buildCompletedPairs(incomingAg3, antigravityScopeId)
  });
  assert.ok(resolvedAg3);
  assert.equal(resolvedAg3.stateId, stateAg2.stateId);
  assert.deepEqual([...resolvedAg3.thoughts], ["thought-O2"]);
});

check("End-to-End Streaming Simulation: accumulated deltas + reasoning survive a full turn, tool loop continues it", () => {
  clearContinuityStateForTests();
  const apiKey = "streaming-user-key";
  const scopeId = deriveContinuityScopeId(apiKey);

  // Turn 1: client calls a tool
  const body1 = { messages: [{ role: "user", content: "look something up" }] };
  const incomingEvents1 = canonicalizeIncomingHistory(body1, "openai");
  const continuityCtx1 = {
    scopeId,
    incomingEvents: incomingEvents1,
    resolvedState: resolveContinuityState({ scopeId, completedPairHashes: buildCompletedPairs(incomingEvents1, scopeId) }),
    continuityCount: 5
  };
  assert.equal(continuityCtx1.resolvedState, null);

  // Provider streams: reasoning delta, then a tool_call delta (mirrors what stream.js feeds the accumulators)
  const thoughtAcc1 = createStreamingThoughtAccumulator();
  const outputAcc1 = createClientOutputAccumulator();
  const providerChunks1 = [
    { choices: [{ delta: { thinking: "need to call the lookup tool" } }] }
  ];
  const clientChunks1 = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "look", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "up", arguments: "{\"q\":1}" } }] } }] }
  ];
  for (const c of providerChunks1) thoughtAcc1.push(c);
  for (const c of clientChunks1) outputAcc1.push(c);

  const state1 = commitContinuityFromClientOutput({
    continuityCtx: continuityCtx1,
    responseThoughts: thoughtAcc1.finalize(),
    clientOutputEvents: outputAcc1.finalize()
  });
  assert.ok(state1);
  assert.deepEqual([...state1.thoughts], ["need to call the lookup tool"]);

  // Turn 2: client sends the tool result back — history now contains the completed tool-call pair
  const body2 = {
    messages: [
      { role: "user", content: "look something up" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "result data" }
    ]
  };
  const incomingEvents2 = canonicalizeIncomingHistory(body2, "openai");
  const resolved2 = resolveContinuityState({ scopeId, completedPairHashes: buildCompletedPairs(incomingEvents2, scopeId) });
  assert.ok(resolved2);
  assert.equal(resolved2.stateId, state1.stateId);
});

check("End-to-End Simulation: tool call id changing between turns (translation hop / combo switch / retry) still resolves", () => {
  clearContinuityStateForTests();
  const apiKey = "tool-id-change-user-key";
  const scopeId = deriveContinuityScopeId(apiKey);

  // Turn 1: client calls a tool. The provider assigns this call an id — here "call_1",
  // standing in for whatever opaque id the FIRST provider/translation hop produced.
  const body1 = { messages: [{ role: "user", content: "look something up" }] };
  const incomingEvents1 = canonicalizeIncomingHistory(body1, "openai");
  const continuityCtx1 = {
    scopeId,
    incomingEvents: incomingEvents1,
    resolvedState: resolveContinuityState({ scopeId, completedPairHashes: buildCompletedPairs(incomingEvents1, scopeId) }),
    continuityCount: 5
  };
  assert.equal(continuityCtx1.resolvedState, null);

  const outputAcc1 = createClientOutputAccumulator();
  outputAcc1.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\":1}" } }] } }] });
  const state1 = commitContinuityFromClientOutput({
    continuityCtx: continuityCtx1,
    responseThoughts: [],
    clientOutputEvents: outputAcc1.finalize()
  });
  assert.ok(state1);

  // Turn 2: the client sends the tool result back, but the id it echoes is "call_9" —
  // e.g. a combo/provider switch or a retry regenerated the call between commit and
  // this request, or a translation hop re-minted the id. Name, arguments, result
  // content, and visible order are all unchanged. Continuity must still resolve to
  // state1 — it must not require the raw transport id to survive verbatim.
  const body2 = {
    messages: [
      { role: "user", content: "look something up" },
      { role: "assistant", tool_calls: [{ id: "call_9", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }] },
      { role: "tool", tool_call_id: "call_9", content: "result data" }
    ]
  };
  const incomingEvents2 = canonicalizeIncomingHistory(body2, "openai");
  const resolved2 = resolveContinuityState({ scopeId, completedPairHashes: buildCompletedPairs(incomingEvents2, scopeId) });
  assert.ok(resolved2);
  assert.equal(resolved2.stateId, state1.stateId);

  // Negative control: if the tool call's actual arguments differ (a genuinely
  // different request, not just a different transport id), it must NOT resolve to
  // state1 — proving this isn't a blanket "ignore tool calls" collapse, only the
  // transport id is exempted. (The trailing tool_result in body2 above never joins a
  // *completed* pair — there is no assistant reply after it yet — so the arguments,
  // still part of the completed call pair, are what a meaningful negative control
  // must vary.)
  const body3 = {
    messages: [
      { role: "user", content: "look something up" },
      { role: "assistant", tool_calls: [{ id: "call_42", type: "function", function: { name: "lookup", arguments: "{\"q\":999}" } }] }
    ]
  };
  const incomingEvents3 = canonicalizeIncomingHistory(body3, "openai");
  const resolved3 = resolveContinuityState({ scopeId, completedPairHashes: buildCompletedPairs(incomingEvents3, scopeId) });
  assert.equal(resolved3, null);
});

check("End-to-End Simulation: fusion judge commits against original client history", () => {
  clearContinuityStateForTests();
  const scopeId = deriveContinuityScopeId("fusion-key");
  const originalBody = { messages: [{ role: "user", content: "solve" }] };
  const incomingOriginal = canonicalizeIncomingHistory(originalBody, "openai");
  const judgeBody = {
    messages: [
      { role: "user", content: "solve" },
      { role: "user", content: "internal fusion judge prompt" }
    ]
  };
  const incomingJudge = canonicalizeIncomingHistory(judgeBody, "openai");
  assert.notDeepEqual(incomingJudge, incomingOriginal);

  const state = commitContinuityFromClientOutput({
    continuityCtx: {
      scopeId,
      incomingEvents: incomingOriginal,
      resolvedState: null,
      continuityCount: 5
    },
    responseThoughts: ["fusion thought"],
    clientOutputEvents: canonicalizeClientOutput({ choices: [{ message: { content: "final fused answer" } }] }, "openai")
  });
  assert.ok(state);

  const nextBody = {
    messages: [
      { role: "user", content: "solve" },
      { role: "assistant", content: "final fused answer" },
      { role: "user", content: "continue" }
    ]
  };
  const incomingNext = canonicalizeIncomingHistory(nextBody, "openai");
  const resolved = resolveContinuityState({
    scopeId,
    completedPairHashes: buildCompletedPairs(incomingNext, scopeId)
  });
  assert.equal(resolved.stateId, state.stateId);
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
