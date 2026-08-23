import assert from "node:assert/strict";
import {
  describeThinkingParams,
  logContinuityRequest,
  logContinuityCapture,
  logContinuityStore,
  logContinuityInject,
  logContinuityDispatch
} from "./continuityLog.js";
import {
  deriveContinuityScopeId,
  canonicalizeIncomingHistory,
  canonicalizeClientOutput,
  buildCompletedPairs,
  describeAllEvents,
  describeAllPairs,
  describeToolLinkage
} from "./continuityCanonicalizer.js";
import {
  resolveContinuityState,
  commitContinuityState,
  commitContinuityFromClientOutput,
  clearContinuityStateForTests
} from "./continuityStore.js";
import { collectResponseThoughts } from "./continuityThoughtCollector.js";

// ─── Mock logger ───────────────────────────────────────────────────────────
// Captures info/debug calls separately so tests can assert which level a
// message landed on, and inspect the exact tag + message string.

function createMockLog() {
  const info = [];
  const debug = [];
  return {
    infoCalls: () => info,
    debugCalls: () => debug,
    info(tag, msg) { info.push({ tag, msg }); },
    debug(tag, msg) { debug.push({ tag, msg }); },
    warn() {},
    error() {}
  };
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ─── Formatter unit tests ──────────────────────────────────────────────────

check("logContinuityRequest: match — emits info with dialog + state + score, no raw content", () => {
  const log = createMockLog();
  const scopeId = "0123456789abcdef";
  const state = { stateId: "aabbccdd-ee", dialogAnchor: "ff048133c3abcd99" };
  logContinuityRequest(log, {
    token: "abc12345",
    scopeId,
    sourceFormat: "openai",
    eventsCount: 7,
    pairsCount: 3,
    lastPair: "ff048133c3abcd",
    resolvedState: state,
    resolveScore: 3,
    reason: null
  });
  const calls = log.infoCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tag, "CONTINUITY");
  const msg = calls[0].msg;
  assert.ok(msg.includes("[REQUEST]"), msg);
  assert.ok(msg.includes("req=abc12345"), msg);
  assert.ok(msg.includes("dialog=ff048133"), msg);
  assert.ok(msg.includes("scope=012345"), msg);
  assert.ok(msg.includes("format=openai"), msg);
  assert.ok(msg.includes("events=7"), msg);
  assert.ok(msg.includes("pairs=3"), msg);
  assert.ok(msg.includes("lastPair=ff048133c3"), msg);
  assert.ok(msg.includes("resolved=aabb score=3"), msg);
  assert.ok(msg.includes("clientThinking=effort=none,thinking=none"), msg);
  // No raw payload / prompt / key
  assert.ok(!msg.includes("prompt"), msg);
  assert.ok(!msg.includes("apiKey"), msg);
});

check("logContinuityRequest: first turn (pairs=0) — resolved=ROOT, dialog=NEW", () => {
  const log = createMockLog();
  logContinuityRequest(log, {
    token: "tok1",
    scopeId: "abcdef",
    sourceFormat: "claude",
    eventsCount: 2,
    pairsCount: 0,
    lastPair: null,
    resolvedState: null,
    resolveScore: 0,
    reason: null
  });
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("pairs=0"), msg);
  assert.ok(msg.includes("resolved=ROOT"), msg);
  assert.ok(msg.includes("dialog=NEW"), msg);
});

check("logContinuityRequest: tie — resolved=none reason=tie, dialog=?", () => {
  const log = createMockLog();
  logContinuityRequest(log, {
    token: "tok2",
    scopeId: "abcdef",
    sourceFormat: "claude",
    eventsCount: 18,
    pairsCount: 5,
    lastPair: "xyz",
    resolvedState: null,
    resolveScore: 2,
    reason: "tie"
  });
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("resolved=none reason=tie"), msg);
  assert.ok(msg.includes("dialog=?"), msg);
});

check("logContinuityRequest: barrier — resolved=none reason=barrier, dialog=?", () => {
  const log = createMockLog();
  logContinuityRequest(log, {
    token: "tok3",
    scopeId: "abcdef",
    sourceFormat: "openai",
    eventsCount: 10,
    pairsCount: 4,
    lastPair: "barrierpair",
    resolvedState: null,
    resolveScore: 0,
    reason: "barrier"
  });
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("resolved=none reason=barrier"), msg);
  assert.ok(msg.includes("dialog=?"), msg);
});

check("logContinuityRequest: zero-score (indexed candidate, no suffix match) — resolved=none reason=zero", () => {
  const log = createMockLog();
  logContinuityRequest(log, {
    token: "tok-zero",
    scopeId: "abcdef",
    sourceFormat: "openai",
    eventsCount: 10,
    pairsCount: 3,
    lastPair: "indexedpair",
    resolvedState: null,
    resolveScore: 0,
    reason: "zero"
  });
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("resolved=none reason=zero"), msg);
  assert.ok(!msg.includes("reason=tie"), msg);
});

check("logContinuityRequest: barrier with pairsCount=0 — barrier reason wins over ROOT", () => {
  const log = createMockLog();
  logContinuityRequest(log, {
    token: "tok-barrier0",
    scopeId: "abcdef",
    sourceFormat: "openai",
    eventsCount: 4,
    pairsCount: 0,
    lastPair: null,
    resolvedState: null,
    resolveScore: 0,
    reason: "barrier"
  });
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("resolved=none reason=barrier"), msg);
  assert.ok(!msg.includes("resolved=ROOT"), msg);
});

check("logContinuityCapture: emits only when thoughts > 0, includes count + chars + source", () => {
  const log = createMockLog();
  logContinuityCapture(log, { token: "t1", thoughtsCount: 2, chars: 8421, source: "stream" });
  assert.equal(log.infoCalls().length, 1);
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("[CAPTURE]"), msg);
  assert.ok(msg.includes("thoughts=2"), msg);
  assert.ok(msg.includes("chars=8421"), msg);
  assert.ok(msg.includes("source=stream"), msg);

  // Zero thoughts → no emit
  const log2 = createMockLog();
  logContinuityCapture(log2, { token: "t2", thoughtsCount: 0, chars: 0, source: "json" });
  assert.equal(log2.infoCalls().length, 0);
});

check("logContinuityStore: emits on every commit (including 0 thoughts), includes dialog/state/parent/pairs/result", () => {
  const log = createMockLog();
  logContinuityStore(log, {
    token: "t1",
    stateId: "b1ca1234-5678",
    dialogAnchor: "2b1558a37cabcd99",
    parentId: "3e82abcd-ef",
    pairs: 5,
    lastPair: "2b1558a37c",
    thoughtsAdded: 2,
    thoughtsCaptured: 2,
    result: "created"
  });
  assert.equal(log.infoCalls().length, 1);
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("[STORE]"), msg);
  assert.ok(msg.includes("dialog=2b1558a3"), msg);
  assert.ok(msg.includes("state=b1ca"), msg);
  assert.ok(msg.includes("parent=3e82"), msg);
  assert.ok(msg.includes("pairs=5"), msg);
  assert.ok(msg.includes("thoughtsAdded=2"), msg);
  assert.ok(msg.includes("thoughtsCaptured=2"), msg);
  assert.ok(msg.includes("result=created"), msg);

  // Zero captured thoughts → still emits (dialog= anchor must be visible at info level)
  const log2 = createMockLog();
  logContinuityStore(log2, { token: "t2", stateId: "x1234567", dialogAnchor: "yabcdefgh", parentId: null, pairs: 1, lastPair: "yabcdefghij", thoughtsAdded: 0, thoughtsCaptured: 0, result: "created" });
  assert.equal(log2.infoCalls().length, 1, "[STORE] should emit even with 0 thoughts");
  const msg2 = log2.infoCalls()[0].msg;
  assert.ok(msg2.includes("thoughtsAdded=0"), msg2);
  assert.ok(msg2.includes("thoughtsCaptured=0"), msg2);
  assert.ok(msg2.includes("parent=ROOT"), msg2);
});

check("logContinuityStore: reused commit reports thoughtsAdded=0, thoughtsCaptured=N", () => {
  const log = createMockLog();
  logContinuityStore(log, {
    token: "t1",
    stateId: "b1ca1234-5678",
    parentId: "3e82abcd-ef",
    pairs: 5,
    lastPair: "2b1558a37c",
    thoughtsAdded: 0,
    thoughtsCaptured: 2,
    result: "reused"
  });
  assert.equal(log.infoCalls().length, 1);
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("thoughtsAdded=0"), msg);
  assert.ok(msg.includes("thoughtsCaptured=2"), msg);
  assert.ok(msg.includes("result=reused"), msg);
});

check("logContinuityInject: emits only when thoughts > 0, includes dialog + sourceState + target", () => {
  const log = createMockLog();
  logContinuityInject(log, {
    token: "t1",
    sourceStateId: "b1ca1234-5678",
    dialogAnchor: "2b1558a37cabcd99",
    thoughtsCount: 2,
    chars: 16384,
    target: "claude"
  });
  assert.equal(log.infoCalls().length, 1);
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("[INJECT]"), msg);
  assert.ok(msg.includes("dialog=2b1558a3"), msg);
  assert.ok(msg.includes("sourceState=b1ca"), msg);
  assert.ok(msg.includes("thoughts=2"), msg);
  assert.ok(msg.includes("chars=16384"), msg);
  assert.ok(msg.includes("target=claude"), msg);

  // Zero thoughts → no emit
  const log2 = createMockLog();
  logContinuityInject(log2, { token: "t2", sourceStateId: "x", dialogAnchor: "y", thoughtsCount: 0, chars: 0, target: "openai" });
  assert.equal(log2.infoCalls().length, 0);
});

// ─── Integration: commit path emits [CAPTURE]/[STORE] only when thoughts exist ──

check("commitContinuityFromClientOutput: [CAPTURE]+[STORE] emitted in info when thoughts > 0", () => {
  clearContinuityStateForTests();
  const log = createMockLog();
  const apiKey = "test-key-capture";
  const scopeId = deriveContinuityScopeId(apiKey);
  const body = { messages: [{ role: "user", content: "hello" }] };
  const incomingEvents = canonicalizeIncomingHistory(body, "openai");
  const continuityCtx = {
    scopeId,
    incomingEvents,
    resolvedState: null,
    continuityCount: 5,
    log,
    requestLogToken: "tok-cap",
    responseSource: "json"
  };
  const response = {
    choices: [{ message: { content: "hi", reasoning_content: "thinking hard" } }]
  };
  const thoughts = collectResponseThoughts(response, "openai").map(t => t.text);
  const clientOut = canonicalizeClientOutput(response, "openai");
  const state = commitContinuityFromClientOutput({ continuityCtx, responseThoughts: thoughts, clientOutputEvents: clientOut });
  assert.ok(state);

  const infoMsgs = log.infoCalls().map(c => c.msg);
  const capture = infoMsgs.find(m => m.includes("[CAPTURE]"));
  const store = infoMsgs.find(m => m.includes("[STORE]"));
  assert.ok(capture, "expected [CAPTURE] in info");
  assert.ok(store, "expected [STORE] in info");
  assert.ok(capture.includes("req=tok-cap"), capture);
  assert.ok(capture.includes("source=json"), capture);
  assert.ok(store.includes("thoughtsAdded=1"), store);
  assert.ok(store.includes("result=created"), store);
});

check("commitContinuityFromClientOutput: [STORE] emitted but no [CAPTURE] when thoughtsAdded=0", () => {
  clearContinuityStateForTests();
  const log = createMockLog();
  const apiKey = "test-key-no-thought";
  const scopeId = deriveContinuityScopeId(apiKey);
  const body = { messages: [{ role: "user", content: "hello" }] };
  const incomingEvents = canonicalizeIncomingHistory(body, "openai");
  const continuityCtx = {
    scopeId,
    incomingEvents,
    resolvedState: null,
    continuityCount: 5,
    log,
    requestLogToken: "tok-no-thought",
    responseSource: "json"
  };
  // Response with no reasoning_content — zero thoughts
  const response = { choices: [{ message: { content: "plain answer" } }] };
  const clientOut = canonicalizeClientOutput(response, "openai");
  const state = commitContinuityFromClientOutput({ continuityCtx, responseThoughts: [], clientOutputEvents: clientOut });
  assert.ok(state, "commit should still happen for pair tracking");

  const infoMsgs = log.infoCalls().map(c => c.msg);
  assert.equal(infoMsgs.find(m => m.includes("[CAPTURE]")), undefined, "no [CAPTURE] when 0 thoughts");
  // [STORE] now fires on every successful commit so dialog= anchor is always visible
  const store = infoMsgs.find(m => m.includes("[STORE]"));
  assert.ok(store, "[STORE] should fire on every commit (even with 0 thoughts)");
  assert.ok(store.includes("thoughtsAdded=0"), store);
  assert.ok(store.includes("thoughtsCaptured=0"), store);
});

check("commitContinuityFromClientOutput: debug traces ([COMMIT-PAIR],[COMMIT],[CANONICAL-OUT],[PAIR-CHAIN-OUT],[TOOL-LINKAGE-OUT]) still emitted", () => {
  clearContinuityStateForTests();
  const log = createMockLog();
  const apiKey = "test-key-debug";
  const scopeId = deriveContinuityScopeId(apiKey);
  const body = { messages: [{ role: "user", content: "hello" }] };
  const incomingEvents = canonicalizeIncomingHistory(body, "openai");
  const continuityCtx = {
    scopeId,
    incomingEvents,
    resolvedState: null,
    continuityCount: 5,
    log,
    requestLogToken: "tok-debug",
    responseSource: "json"
  };
  const response = { choices: [{ message: { content: "hi", reasoning_content: "think" } }] };
  const thoughts = collectResponseThoughts(response, "openai").map(t => t.text);
  const clientOut = canonicalizeClientOutput(response, "openai");
  commitContinuityFromClientOutput({ continuityCtx, responseThoughts: thoughts, clientOutputEvents: clientOut });

  const debugMsgs = log.debugCalls().map(c => c.msg);
  assert.ok(debugMsgs.find(m => m.includes("[COMMIT-PAIR]")), "debug [COMMIT-PAIR] preserved");
  assert.ok(debugMsgs.find(m => m.includes("[COMMIT]")), "debug [COMMIT] preserved");
  assert.ok(debugMsgs.find(m => m.includes("[CANONICAL-OUT]")), "debug [CANONICAL-OUT] emitted");
  assert.ok(debugMsgs.find(m => m.includes("[PAIR-CHAIN-OUT]")), "debug [PAIR-CHAIN-OUT] emitted");
  assert.ok(debugMsgs.find(m => m.includes("[TOOL-LINKAGE-OUT]")), "debug [TOOL-LINKAGE-OUT] emitted");
  // [COMMIT-SHAPE] was removed — subsumed by [CANONICAL-OUT] + [CANONICAL-IN]
  assert.equal(debugMsgs.find(m => m.includes("[COMMIT-SHAPE]")), undefined, "[COMMIT-SHAPE] removed (redundant with [CANONICAL-OUT])");
});

// ─── Integration: resolver resultMeta surfaces reason in compact log ───────

check("resolveContinuityState: resultMeta captures tie reason + score", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-tie";
  // Two states with same last pair → tie
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-X", "pair-common"],
    continuityCount: 3
  });
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t2"],
    finalPairWindow: ["pair-Y", "pair-common"],
    continuityCount: 3
  });
  const meta = {};
  const resolved = resolveContinuityState({
    scopeId,
    completedPairHashes: ["pair-common"],
    log: createMockLog(),
    resultMeta: meta
  });
  assert.equal(resolved, null);
  assert.equal(meta.reason, "tie");
});

check("resolveContinuityState: resultMeta captures match reason + score", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-match";
  const s1 = commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-A", "pair-B"],
    continuityCount: 3
  });
  const meta = {};
  const resolved = resolveContinuityState({
    scopeId,
    completedPairHashes: ["pair-A", "pair-B"],
    log: createMockLog(),
    resultMeta: meta
  });
  assert.ok(resolved);
  assert.equal(resolved.stateId, s1.stateId);
  assert.equal(meta.reason, "match");
  assert.equal(meta.score, 2);
});

check("resolveContinuityState: resultMeta captures no-match reason", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-nomatch";
  const meta = {};
  const resolved = resolveContinuityState({
    scopeId,
    completedPairHashes: ["nonexistent-pair"],
    log: createMockLog(),
    resultMeta: meta
  });
  assert.equal(resolved, null);
  assert.equal(meta.reason, "no-match");
});

check("resolveContinuityState: resultMeta captures tie reason (two states, same last pair)", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-tie2";
  // Two states sharing the same last pair → tie
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-X", "pair-common"],
    continuityCount: 3
  });
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t2"],
    finalPairWindow: ["pair-Y", "pair-common"],
    continuityCount: 3
  });
  const meta = {};
  const resolved = resolveContinuityState({
    scopeId,
    completedPairHashes: ["pair-common"],
    log: createMockLog(),
    resultMeta: meta
  });
  assert.equal(resolved, null);
  assert.equal(meta.reason, "tie");
});

check("resolveContinuityState: resultMeta captures zero reason (indexed candidate, no suffix match)", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-zero";
  // State whose window ends with pair-B but is also indexed by pair-A (its first pair).
  // Incoming last pair = pair-A → candidate is found via pairIndex, but suffixScore
  // returns 0 because pair-A is not at the end of the candidate window.
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-A", "pair-B"],
    continuityCount: 3
  });
  const meta = {};
  const resolved = resolveContinuityState({
    scopeId,
    completedPairHashes: ["pair-A"],
    log: createMockLog(),
    resultMeta: meta
  });
  assert.equal(resolved, null);
  assert.equal(meta.reason, "zero", "zero-score must surface as reason=zero, not tie");
  assert.equal(meta.score, 0);
});

check("commitContinuityState: resultMeta.result=created for new state, no _commitResult on state", () => {
  clearContinuityStateForTests();
  const meta = {};
  const state = commitContinuityState({
    scopeId: "tenant-meta-created",
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-A"],
    continuityCount: 3,
    resultMeta: meta
  });
  assert.ok(state);
  assert.equal(meta.result, "created");
  assert.equal(state._commitResult, undefined, "state must not carry transient _commitResult");
});

check("commitContinuityState: resultMeta.result=reused for idempotent commit, no _commitResult on state", () => {
  clearContinuityStateForTests();
  const scopeId = "tenant-meta-reused";
  const meta1 = {};
  const s1 = commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-A", "pair-B"],
    continuityCount: 3,
    resultMeta: meta1
  });
  assert.equal(meta1.result, "created");
  const meta2 = {};
  const s2 = commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["t1"],
    finalPairWindow: ["pair-A", "pair-B"],
    continuityCount: 3,
    resultMeta: meta2
  });
  assert.equal(s2.stateId, s1.stateId);
  assert.equal(meta2.result, "reused");
  assert.equal(s2._commitResult, undefined, "state must not carry transient _commitResult");
});

// ─── Integration: end-to-end capture → inject chain ────────────────────────

check("end-to-end: capture on turn 1, inject on turn 2, req tokens differ but state links them", () => {
  clearContinuityStateForTests();
  const apiKey = "e2e-key";
  const scopeId = deriveContinuityScopeId(apiKey);

  // Turn 1: commit with a thought
  const log1 = createMockLog();
  const body1 = { messages: [{ role: "user", content: "what is 2+2" }] };
  const incomingEvents1 = canonicalizeIncomingHistory(body1, "openai");
  const ctx1 = {
    scopeId,
    incomingEvents: incomingEvents1,
    resolvedState: null,
    continuityCount: 5,
    log: log1,
    requestLogToken: "req-turn1",
    responseSource: "json"
  };
  const resp1 = { choices: [{ message: { content: "4", reasoning_content: "calculating" } }] };
  const thoughts1 = collectResponseThoughts(resp1, "openai").map(t => t.text);
  const clientOut1 = canonicalizeClientOutput(resp1, "openai");
  const state1 = commitContinuityFromClientOutput({ continuityCtx: ctx1, responseThoughts: thoughts1, clientOutputEvents: clientOut1 });
  assert.ok(state1);

  // Turn 1 logs: [CAPTURE] + [STORE] in info
  const info1 = log1.infoCalls().map(c => c.msg);
  const capture1 = info1.find(m => m.includes("[CAPTURE]"));
  const store1 = info1.find(m => m.includes("[STORE]"));
  assert.ok(capture1 && capture1.includes("req=req-turn1"), "turn1 capture has req token");
  assert.ok(store1 && store1.includes("req=req-turn1"), "turn1 store has req token");
  assert.ok(store1.includes(`state=${state1.stateId.slice(0, 4)}`), "store references committed state");
  // Turn 1 store has dialog anchor derived from the first pair hash
  assert.ok(state1.dialogAnchor, "committed state has dialogAnchor");
  assert.ok(store1.includes(`dialog=${state1.dialogAnchor.slice(0, 8)}`), "store log includes dialog anchor");

  // Turn 2: resolve finds state1, inject emits with sourceState
  const log2 = createMockLog();
  const body2 = {
    messages: [
      { role: "user", content: "what is 2+2" },
      { role: "assistant", content: "4" },
      { role: "user", content: "and 3+3" }
    ]
  };
  const incomingEvents2 = canonicalizeIncomingHistory(body2, "openai");
  const pairs2 = buildCompletedPairs(incomingEvents2, scopeId);
  const meta2 = {};
  const resolved2 = resolveContinuityState({ scopeId, completedPairHashes: pairs2, log: log2, resultMeta: meta2 });
  assert.ok(resolved2);
  assert.equal(resolved2.stateId, state1.stateId);
  // Resolved state carries the same dialog anchor — it's the same dialog
  assert.equal(resolved2.dialogAnchor, state1.dialogAnchor, "resolved state inherits dialog anchor");

  // Simulate the [REQUEST] + [INJECT] info logs as chatCore would emit them
  logContinuityRequest(log2, {
    token: "req-turn2",
    scopeId,
    sourceFormat: "openai",
    eventsCount: incomingEvents2.length,
    pairsCount: pairs2.length,
    lastPair: pairs2[pairs2.length - 1],
    resolvedState: resolved2,
    resolveScore: meta2.score,
    reason: null
  });
  // Simulate inject (chatCore does this with budgetThoughts)
  logContinuityInject(log2, {
    token: "req-turn2",
    sourceStateId: resolved2.stateId,
    dialogAnchor: resolved2.dialogAnchor,
    thoughtsCount: 1,
    chars: 10,
    target: "openai"
  });

  const info2 = log2.infoCalls().map(c => c.msg);
  const request2 = info2.find(m => m.includes("[REQUEST]"));
  const inject2 = info2.find(m => m.includes("[INJECT]"));
  assert.ok(request2 && request2.includes("req=req-turn2"), "turn2 request has its own req token");
  assert.ok(request2.includes(`resolved=${state1.stateId.slice(0, 4)}`), "request references resolved state");
  // Turn 2 request shows the SAME dialog anchor as turn 1 — same dialog
  assert.ok(request2.includes(`dialog=${state1.dialogAnchor.slice(0, 8)}`), "turn2 request shows same dialog anchor as turn1");
  assert.ok(inject2 && inject2.includes("req=req-turn2"), "turn2 inject has its own req token");
  assert.ok(inject2.includes(`sourceState=${state1.stateId.slice(0, 4)}`), "inject references source state");
  assert.ok(inject2.includes(`dialog=${state1.dialogAnchor.slice(0, 8)}`), "turn2 inject shows same dialog anchor");
  // req tokens differ between turns
  assert.notEqual("req-turn1", "req-turn2");
});

// ─── Dialog anchor: different dialogs get different anchors ───────────────

check("dialogAnchor: two independent dialogs on same API key get different anchors", () => {
  clearContinuityStateForTests();
  const apiKey = "shared-key";
  const scopeId = deriveContinuityScopeId(apiKey);

  // Dialog A: first turn
  const logA = createMockLog();
  const bodyA1 = { messages: [{ role: "user", content: "dialog A question" }] };
  const eventsA1 = canonicalizeIncomingHistory(bodyA1, "openai");
  const ctxA1 = { scopeId, incomingEvents: eventsA1, resolvedState: null, continuityCount: 5, log: logA, requestLogToken: "reqA1", responseSource: "json" };
  const respA1 = { choices: [{ message: { content: "answer A", reasoning_content: "thinking A" } }] };
  const stateA1 = commitContinuityFromClientOutput({
    continuityCtx: ctxA1,
    responseThoughts: collectResponseThoughts(respA1, "openai").map(t => t.text),
    clientOutputEvents: canonicalizeClientOutput(respA1, "openai")
  });
  assert.ok(stateA1?.dialogAnchor, "dialog A state has anchor");

  // Dialog B: different first turn on the SAME API key
  const logB = createMockLog();
  const bodyB1 = { messages: [{ role: "user", content: "completely different question B" }] };
  const eventsB1 = canonicalizeIncomingHistory(bodyB1, "openai");
  const ctxB1 = { scopeId, incomingEvents: eventsB1, resolvedState: null, continuityCount: 5, log: logB, requestLogToken: "reqB1", responseSource: "json" };
  const respB1 = { choices: [{ message: { content: "answer B", reasoning_content: "thinking B" } }] };
  const stateB1 = commitContinuityFromClientOutput({
    continuityCtx: ctxB1,
    responseThoughts: collectResponseThoughts(respB1, "openai").map(t => t.text),
    clientOutputEvents: canonicalizeClientOutput(respB1, "openai")
  });
  assert.ok(stateB1?.dialogAnchor, "dialog B state has anchor");

  // Different dialogs → different anchors
  assert.notEqual(stateA1.dialogAnchor, stateB1.dialogAnchor, "different dialogs must have different anchors");

  // Dialog A turn 2: resolve finds stateA1, inherits its anchor
  const bodyA2 = {
    messages: [
      { role: "user", content: "dialog A question" },
      { role: "assistant", content: "answer A" },
      { role: "user", content: "follow up A" }
    ]
  };
  const eventsA2 = canonicalizeIncomingHistory(bodyA2, "openai");
  const pairsA2 = buildCompletedPairs(eventsA2, scopeId);
  const resolvedA2 = resolveContinuityState({ scopeId, completedPairHashes: pairsA2, log: createMockLog(), resultMeta: {} });
  assert.ok(resolvedA2);
  assert.equal(resolvedA2.dialogAnchor, stateA1.dialogAnchor, "dialog A turn 2 inherits same anchor");
});

// ─── Dialog anchor: inherited through child commits ───────────────────────

check("dialogAnchor: child commit inherits parent's anchor, not re-derived from new first pair", () => {
  clearContinuityStateForTests();
  const apiKey = "inherit-key";
  const scopeId = deriveContinuityScopeId(apiKey);

  // Turn 1: root commit
  const body1 = { messages: [{ role: "user", content: "first turn" }] };
  const events1 = canonicalizeIncomingHistory(body1, "openai");
  const ctx1 = { scopeId, incomingEvents: events1, resolvedState: null, continuityCount: 5, log: createMockLog(), requestLogToken: "t1", responseSource: "json" };
  const resp1 = { choices: [{ message: { content: "reply 1", reasoning_content: "think 1" } }] };
  const state1 = commitContinuityFromClientOutput({
    continuityCtx: ctx1,
    responseThoughts: collectResponseThoughts(resp1, "openai").map(t => t.text),
    clientOutputEvents: canonicalizeClientOutput(resp1, "openai")
  });
  assert.ok(state1);

  // Turn 2: resolve state1, commit child
  const body2 = {
    messages: [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "second turn" }
    ]
  };
  const events2 = canonicalizeIncomingHistory(body2, "openai");
  const pairs2 = buildCompletedPairs(events2, scopeId);
  const resolved2 = resolveContinuityState({ scopeId, completedPairHashes: pairs2, log: createMockLog(), resultMeta: {} });
  assert.ok(resolved2);
  const ctx2 = { scopeId, incomingEvents: events2, resolvedState: resolved2, continuityCount: 5, log: createMockLog(), requestLogToken: "t2", responseSource: "json" };
  const resp2 = { choices: [{ message: { content: "reply 2", reasoning_content: "think 2" } }] };
  const state2 = commitContinuityFromClientOutput({
    continuityCtx: ctx2,
    responseThoughts: collectResponseThoughts(resp2, "openai").map(t => t.text),
    clientOutputEvents: canonicalizeClientOutput(resp2, "openai")
  });
  assert.ok(state2);
  // Child inherits parent's anchor — NOT re-derived from the new pair window
  assert.equal(state2.dialogAnchor, state1.dialogAnchor, "child state inherits parent's dialog anchor");
});

// ─── Diagnostic functions: describeAllEvents, describeAllPairs, describeToolLinkage ──

check("describeAllEvents: emits per-event digests with payload summaries, no raw content", () => {
  const events = [
    { role: "user", kind: "text", payload: "hello world this is a test" },
    { role: "assistant", kind: "text", payload: "hi there" },
    { role: "assistant", kind: "tool_call", payload: { name: "search", arguments: '{"q":"secret"}', rawLink: "call_1" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "call_1", nameHint: "search", content: "result text here" } }
  ];
  const desc = describeAllEvents(events);
  assert.ok(desc.includes("events=4"), desc);
  assert.ok(desc.includes("[0]"), desc);
  assert.ok(desc.includes("user:text#"), desc);
  assert.ok(desc.includes("assistant:text#"), desc);
  assert.ok(desc.includes("assistant:tool_call#"), desc);
  assert.ok(desc.includes("tool:tool_result#"), desc);
  // Payload summaries present
  assert.ok(desc.includes("text:26c"), desc); // "hello world this is a test" = 26 chars
  assert.ok(desc.includes("text:8c"), desc);  // "hi there" = 8 chars
  assert.ok(desc.includes("tool:search,"), desc);
  // No raw content
  assert.ok(!desc.includes("hello world"), `leaked text: ${desc}`);
  assert.ok(!desc.includes("secret"), `leaked tool arg: ${desc}`);
  assert.ok(!desc.includes("result text"), `leaked tool result: ${desc}`);
});

check("describeAllEvents: empty array returns events=0", () => {
  assert.equal(describeAllEvents([]), "events=0");
  assert.equal(describeAllEvents(null), "events=0");
});

check("describeAllPairs: shows all pairs with hashes + barrier markers + event digests", () => {
  const apiKey = "pairs-test-key";
  const scopeId = deriveContinuityScopeId(apiKey);
  const body = {
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "openai");
  const desc = describeAllPairs(events, scopeId);
  assert.ok(desc.includes("pairs=2"), desc);
  assert.ok(desc.includes("[0]pair="), desc);
  assert.ok(desc.includes("[1]pair="), desc);
  assert.ok(desc.includes("in=["), desc);
  assert.ok(desc.includes("out=["), desc);
  // No BARRIER marker on a clean history
  assert.ok(!desc.includes("BARRIER"), desc);
  // No raw content
  assert.ok(!desc.includes("first question"), `leaked: ${desc}`);
  assert.ok(!desc.includes("second answer"), `leaked: ${desc}`);
});

check("describeAllPairs: no scope → pair=no-scope, still shows event digests", () => {
  const body = {
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "openai");
  const desc = describeAllPairs(events, null);
  assert.ok(desc.includes("no-scope"), desc);
  assert.ok(desc.includes("user:text#"), desc);
});

check("describeToolLinkage: shows linked tool calls and results, no raw content", () => {
  const body = {
    messages: [
      { role: "user", content: "use the tool" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"secret query"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "secret result data" },
      { role: "assistant", content: "done" }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "openai");
  const desc = describeToolLinkage(events);
  assert.ok(desc.includes("toolLinks:"), desc);
  assert.ok(desc.includes("search"), desc);
  assert.ok(desc.includes("→result("), desc);
  // No raw content
  assert.ok(!desc.includes("secret query"), `leaked tool arg: ${desc}`);
  assert.ok(!desc.includes("secret result"), `leaked tool result: ${desc}`);
});

check("describeToolLinkage: unlinked result shown as orphan, pending call shown as pending", () => {
  const body = {
    messages: [
      { role: "user", content: "use tools" },
      { role: "assistant", content: null, tool_calls: [
        { id: "call_1", type: "function", function: { name: "search", arguments: '{}' } },
        { id: "call_2", type: "function", function: { name: "fetch", arguments: '{}' } }
      ]},
      { role: "tool", tool_call_id: "call_1", content: "result 1" },
      { role: "assistant", content: "partial" }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "openai");
  const desc = describeToolLinkage(events);
  // call_1 linked, call_2 pending (no result) — pending collapsed to count
  assert.ok(desc.includes("search") && desc.includes("→result("), desc);
  assert.ok(desc.includes("pending:1"), desc);
  assert.ok(!desc.includes("→pending"), "individual →pending entries collapsed to pending:N");
});

check("describeToolLinkage: no tools → toolLinks: none", () => {
  const events = [
    { role: "user", kind: "text", payload: "hello" },
    { role: "assistant", kind: "text", payload: "hi" }
  ];
  assert.equal(describeToolLinkage(events), "toolLinks: none");
});

// ─── No raw content leakage ────────────────────────────────────────────────

check("no raw thought text, prompt, tool args, or API keys in any info-level continuity log", () => {
  clearContinuityStateForTests();
  const log = createMockLog();
  const secretThought = "TOP_SECRET_REASONING_TEXT_12345";
  const secretPrompt = "USER_SECRET_PROMPT_67890";
  const secretToolArg = "SECRET_TOOL_ARGUMENT_42";
  const apiKey = "sk-secret-key-999";

  // Drive the real commit path with secret-bearing inputs so the test exercises
  // the actual sensitive-data path, not just hardcoded formatter args.
  const scopeId = deriveContinuityScopeId(apiKey);
  const body = { messages: [{ role: "user", content: secretPrompt }] };
  const incomingEvents = canonicalizeIncomingHistory(body, "openai");
  const continuityCtx = {
    scopeId,
    incomingEvents,
    resolvedState: null,
    continuityCount: 5,
    log,
    requestLogToken: "tok-leak",
    responseSource: "json"
  };
  const response = {
    choices: [{
      message: {
        content: "ok",
        reasoning_content: secretThought,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: JSON.stringify({ q: secretToolArg }) } }]
      }
    }]
  };
  const thoughts = collectResponseThoughts(response, "openai").map(t => t.text);
  const clientOut = canonicalizeClientOutput(response, "openai");
  const state = commitContinuityFromClientOutput({ continuityCtx, responseThoughts: thoughts, clientOutputEvents: clientOut });
  assert.ok(state, "commit should land so [CAPTURE]/[STORE] are emitted");

  // Also exercise the request + inject formatters with the secret scope/key material
  // nearby — formatters must not echo it.
  logContinuityRequest(log, {
    token: "tok-leak",
    scopeId,
    sourceFormat: "openai",
    eventsCount: incomingEvents.length,
    pairsCount: 1,
    lastPair: "abcdef1234",
    resolvedState: state,
    resolveScore: 1,
    reason: null
  });
  logContinuityInject(log, {
    token: "tok-leak",
    sourceStateId: state.stateId,
    thoughtsCount: 1,
    chars: 100,
    target: "openai"
  });

  for (const { msg } of log.infoCalls()) {
    assert.ok(!msg.includes(secretThought), `leaked thought text: ${msg}`);
    assert.ok(!msg.includes(secretPrompt), `leaked prompt: ${msg}`);
    assert.ok(!msg.includes(secretToolArg), `leaked tool arg: ${msg}`);
    assert.ok(!msg.includes(apiKey), `leaked API key: ${msg}`);
  }
});

// ─── [COMMIT] debug trace distinguishes total thoughts from newly added ──────

check("[COMMIT] debug trace includes added=N alongside thoughts=N (total)", () => {
  clearContinuityStateForTests();
  const log = createMockLog();
  const apiKey = "test-key-commit-added";
  const scopeId = deriveContinuityScopeId(apiKey);
  const body = { messages: [{ role: "user", content: "hello" }] };
  const incomingEvents = canonicalizeIncomingHistory(body, "openai");
  const ctx1 = {
    scopeId, incomingEvents, resolvedState: null, continuityCount: 5,
    log, requestLogToken: "tok-added-1", responseSource: "json"
  };
  const resp1 = { choices: [{ message: { content: "hi", reasoning_content: "think1" } }] };
  const thoughts1 = collectResponseThoughts(resp1, "openai").map(t => t.text);
  const clientOut1 = canonicalizeClientOutput(resp1, "openai");
  const state1 = commitContinuityFromClientOutput({ continuityCtx: ctx1, responseThoughts: thoughts1, clientOutputEvents: clientOut1 });
  assert.ok(state1);

  // Turn 2: no new thoughts, but state inherits thought from turn 1
  const ctx2 = {
    scopeId, incomingEvents: [...incomingEvents, ...clientOut1], resolvedState: state1,
    continuityCount: 5, log, requestLogToken: "tok-added-2", responseSource: "json"
  };
  const resp2 = { choices: [{ message: { content: "answer" } }] };
  const clientOut2 = canonicalizeClientOutput(resp2, "openai");
  commitContinuityFromClientOutput({ continuityCtx: ctx2, responseThoughts: [], clientOutputEvents: clientOut2 });

  const debugMsgs = log.debugCalls().map(c => c.msg);
  const commits = debugMsgs.filter(m => m.includes("[COMMIT]") && m.includes("result=created"));
  assert.ok(commits.length >= 2, "expected at least 2 created commits");
  // Turn 1: thoughts=1 (total), added=1 (new)
  const commit1 = commits[0];
  assert.ok(commit1.includes("thoughts=1"), commit1);
  assert.ok(commit1.includes("added=1"), commit1);
  // Turn 2: thoughts=1 (inherited total), added=0 (no new)
  const commit2 = commits[1];
  assert.ok(commit2.includes("thoughts=1"), commit2);
  assert.ok(commit2.includes("added=0"), commit2);
});

// ─── describeThinkingParams + [DISPATCH] effort/thinking sync ──────────────

check("describeThinkingParams: empty/missing body → effort=none,thinking=none", () => {
  assert.equal(describeThinkingParams(null), "effort=none,thinking=none");
  assert.equal(describeThinkingParams({}), "effort=none,thinking=none");
  assert.equal(describeThinkingParams({ reasoning_effort: "high" }), "effort=high,thinking=none");
});

check("describeThinkingParams: Claude thinking enabled + budget", () => {
  const s = describeThinkingParams({ thinking: { type: "enabled", budget_tokens: 10000 } });
  assert.ok(s.includes("effort=none"), s);
  assert.ok(s.includes("thinking=enabled"), s);
  assert.ok(s.includes("budget=10000"), s);
  assert.ok(!s.includes("interval="), s);
});

check("describeThinkingParams: adaptive + interval (syncing params) surfaced", () => {
  const s = describeThinkingParams({ thinking: { type: "adaptive", interval: 2048, budget_tokens: 5000 } });
  assert.ok(s.includes("thinking=adaptive"), s);
  assert.ok(s.includes("adaptive=on"), s);
  assert.ok(s.includes("interval=2048"), s);
});

check("describeThinkingParams: output_config.effort + reasoning.effort fallback", () => {
  const s1 = describeThinkingParams({ reasoning: { effort: "medium" } });
  assert.ok(s1.includes("effort=medium"), s1);
  const s2 = describeThinkingParams({ output_config: { effort: "low" } });
  assert.ok(s2.includes("outputEffort=low"), s2);
});

check("logContinuityRequest: clientThinking includes effort from client body", () => {
  const log = createMockLog();
  logContinuityRequest(log, {
    token: "t1", scopeId: "abc", sourceFormat: "openai",
    eventsCount: 2, pairsCount: 0, lastPair: null,
    resolvedState: null, resolveScore: 0, reason: null,
    clientThinking: describeThinkingParams({ reasoning_effort: "high" })
  });
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("clientThinking=effort=high"), msg);
});

check("logContinuityDispatch: emits provider/model/stream/override/providerThinking at info", () => {
  const log = createMockLog();
  logContinuityDispatch(log, {
    token: "t1", scopeId: "abcdef",
    dialogAnchor: "2b1558a37cabcd99",
    isNew: false,
    provider: "antigravity", model: "claude-sonnet-4-20250514",
    stream: true,
    overrideMode: "on",
    providerThinking: describeThinkingParams({ thinking: { type: "enabled", budget_tokens: 10000 } })
  });
  assert.equal(log.infoCalls().length, 1);
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("[DISPATCH]"), msg);
  assert.ok(msg.includes("req=t1"), msg);
  assert.ok(msg.includes("dialog=2b1558a3"), msg);
  assert.ok(msg.includes("provider=antigravity"), msg);
  assert.ok(msg.includes("stream=on"), msg);
  assert.ok(msg.includes("override=on"), msg);
  assert.ok(msg.includes("providerThinking=effort=none,thinking=enabled,budget=10000"), msg);
  assert.ok(!msg.includes("apiKey"), msg);
});

check("logContinuityDispatch: first-turn (isNew) → dialog=NEW", () => {
  const log = createMockLog();
  logContinuityDispatch(log, {
    token: "t1", scopeId: "abc", isNew: true,
    provider: "openai", model: "gpt-4o", stream: false,
    overrideMode: "auto",
    providerThinking: describeThinkingParams({})
  });
  const msg = log.infoCalls()[0].msg;
  assert.ok(msg.includes("dialog=NEW"), msg);
  assert.ok(msg.includes("override=auto"), msg);
  assert.ok(msg.includes("stream=off"), msg);
});

// ─── Run ───────────────────────────────────────────────────────────────────

// Wrap async checks
async function runChecks() {
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
}

runChecks();
