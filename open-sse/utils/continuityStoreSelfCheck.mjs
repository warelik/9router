import assert from "node:assert/strict";
import {
  resolveContinuityState,
  commitContinuityState,
  commitContinuityFromClientOutput,
  clearContinuityStateForTests,
  clearExpiredContinuityStates
} from "./continuityStore.js";
import { analyzeContinuityHistory } from "./continuityCanonicalizer.js";

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check("resolve & commit: strict suffix scoring + matched lookup", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-1";

  // State 1: A -> B -> C -> D
  const parent = null;
  const state1 = commitContinuityState({
    scopeId,
    parentState: parent,
    responseThoughts: ["t1", "t2"],
    finalPairWindow: ["pair-A", "pair-B", "pair-C"],
    continuityCount: 3
  });

  // State 2: X -> Y -> C -> D
  const state2 = commitContinuityState({
    scopeId,
    parentState: parent,
    responseThoughts: ["t3", "t4"],
    finalPairWindow: ["pair-X", "pair-B", "pair-C"],
    continuityCount: 3
  });

  // Resolve with history ending in: pair-B, pair-C
  // This is a tie between state1 and state2 since both match suffix of length 2
  const resolvedTie = resolveContinuityState({
    scopeId,
    completedPairHashes: ["pair-B", "pair-C"]
  });
  assert.equal(resolvedTie, null);

  // Resolve with history: pair-A, pair-B, pair-C
  // state1 should win because it has suffix match of 3, while state2 has suffix match of 2
  const resolvedWinner = resolveContinuityState({
    scopeId,
    completedPairHashes: ["pair-A", "pair-B", "pair-C"]
  });
  assert.ok(resolvedWinner);
  assert.equal(resolvedWinner.stateId, state1.stateId);
});

check("idempotency: committing same state outputs should return original instance", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-1";

  const s1 = commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-1"],
    continuityCount: 3
  });

  const s2 = commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-1"],
    continuityCount: 3
  });

  assert.equal(s1.stateId, s2.stateId);
});

check("commitContinuityFromClientOutput: composes canonicalizer + store, drops oversize thoughts, no-ops on empty output", () => {
  clearContinuityStateForTests();
  const continuityCtx = {
    scopeId: "tenant-2",
    incomingEvents: [{ role: "user", kind: "text", payload: "hi" }],
    resolvedState: null,
    continuityCount: 5
  };

  const oversized = "x".repeat(40000);
  const committed = commitContinuityFromClientOutput({
    continuityCtx,
    responseThoughts: ["kept", oversized],
    clientOutputEvents: [{ role: "assistant", kind: "text", payload: "hello" }]
  });
  assert.ok(committed);
  assert.deepEqual([...committed.thoughts], ["kept"]);

  const noOp = commitContinuityFromClientOutput({
    continuityCtx,
    responseThoughts: ["ignored"],
    clientOutputEvents: []
  });
  assert.equal(noOp, null);
});

check("commitContinuityState: thought/pair digests must not collide on join-boundary ambiguity", () => {
  clearContinuityStateForTests();
  const scopeId = "scope";

  // ["a\nb"] (one record containing a newline) vs ["a","b"] (two distinct
  // records) must never share a commitKey — join("\n") would flatten both
  // to the same "a\nb" string and silently merge two different thought
  // sequences into one snapshot identity.
  const stateA = commitContinuityState({
    scopeId,
    parentState: null,
    finalPairWindow: ["pair"],
    responseThoughts: ["a\nb"],
    continuityCount: 7
  });
  const stateB = commitContinuityState({
    scopeId,
    parentState: null,
    finalPairWindow: ["pair"],
    responseThoughts: ["a", "b"],
    continuityCount: 7
  });
  assert.notEqual(stateA.stateId, stateB.stateId);

  // Same ambiguity on the pair-window digest: join(",") would flatten
  // ["p,q"] and ["p","q"] to the same string.
  const stateC = commitContinuityState({
    scopeId,
    parentState: null,
    finalPairWindow: ["p,q"],
    responseThoughts: ["t"],
    continuityCount: 7
  });
  const stateD = commitContinuityState({
    scopeId,
    parentState: null,
    finalPairWindow: ["p", "q"],
    responseThoughts: ["t"],
    continuityCount: 7
  });
  assert.notEqual(stateC.stateId, stateD.stateId);

  // Identical input must still be idempotent after the fix.
  const stateA2 = commitContinuityState({
    scopeId,
    parentState: null,
    finalPairWindow: ["pair"],
    responseThoughts: ["a\nb"],
    continuityCount: 7
  });
  assert.equal(stateA.stateId, stateA2.stateId);
});

check("scoping: API key scopes should never leak across tenants", () => {
  clearContinuityStateForTests();
  commitContinuityState({
    scopeId: "scope-A",
    parentState: null,
    responseThoughts: ["thought-A"],
    finalPairWindow: ["pair-common"],
    continuityCount: 3
  });

  const resolved = resolveContinuityState({
    scopeId: "scope-B",
    completedPairHashes: ["pair-common"]
  });
  assert.equal(resolved, null);
});

check("resolve: recovers monotonic assistant-output drift without fuzzy input matching", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-drift";
  const firstTurn = [{ role: "user", kind: "text", payload: "question" }];
  const state = commitContinuityFromClientOutput({
    continuityCtx: { scopeId, incomingEvents: firstTurn, resolvedState: null, continuityCount: 3 },
    responseThoughts: ["kept"],
    clientOutputEvents: [{ role: "assistant", kind: "text", payload: "answer visible to client plus extra transport suffix" }]
  });
  assert.ok(state);

  const drifted = analyzeContinuityHistory([...firstTurn, { role: "assistant", kind: "text", payload: "answer visible to client" }], scopeId);
  assert.notEqual(drifted.pairHashes[0], state.pairWindow[0]);
  clearContinuityStateForTests();

  const committed = commitContinuityFromClientOutput({
    continuityCtx: { scopeId, incomingEvents: firstTurn, resolvedState: null, continuityCount: 3 },
    responseThoughts: ["kept"],
    clientOutputEvents: [{ role: "assistant", kind: "text", payload: "answer visible to client plus extra transport suffix" }]
  });
  const resolved = resolveContinuityState({
    scopeId,
    completedPairHashes: drifted.pairHashes,
    completedPairRecords: drifted.postBarrierRecords
  });
  assert.equal(resolved.stateId, committed.stateId);
});

check("resolve: rejects ambiguous or semantic output drift", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-drift-ambiguous";
  const incomingEvents = [{ role: "user", kind: "text", payload: "same input" }];
  const shortOutput = [{ role: "assistant", kind: "text", payload: "shared assistant output body" }];
  commitContinuityFromClientOutput({ continuityCtx: { scopeId, incomingEvents, resolvedState: null, continuityCount: 3 }, responseThoughts: ["a"], clientOutputEvents: [{ role: "assistant", kind: "text", payload: "shared assistant output body with suffix one" }] });
  commitContinuityFromClientOutput({ continuityCtx: { scopeId, incomingEvents, resolvedState: null, continuityCount: 3 }, responseThoughts: ["b"], clientOutputEvents: [{ role: "assistant", kind: "text", payload: "shared assistant output body with suffix two" }] });
  const replay = analyzeContinuityHistory([...incomingEvents, ...shortOutput], scopeId);
  assert.equal(resolveContinuityState({ scopeId, completedPairHashes: replay.pairHashes, completedPairRecords: replay.postBarrierRecords }), null);

  clearContinuityStateForTests();
  commitContinuityFromClientOutput({ continuityCtx: { scopeId, incomingEvents, resolvedState: null, continuityCount: 3 }, responseThoughts: ["a"], clientOutputEvents: [{ role: "assistant", kind: "text", payload: "original answer text long enough" }] });
  const changed = analyzeContinuityHistory([...incomingEvents, { role: "assistant", kind: "text", payload: "different semantic answer long enough" }], scopeId);
  assert.equal(resolveContinuityState({ scopeId, completedPairHashes: changed.pairHashes, completedPairRecords: changed.postBarrierRecords }), null);
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
