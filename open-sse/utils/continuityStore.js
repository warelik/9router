import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import crypto from "crypto";
import { analyzeContinuityHistory, buildPairWindow, describeLastCompletedPair, describeAllEvents, describeAllPairs, describeToolLinkage } from "./continuityCanonicalizer.js";
import { filterOversizeThoughts } from "./continuityThoughtCollector.js";
import { logContinuityCapture, logContinuityStore } from "./continuityLog.js";

const statesById = new Map();
const pairIndex = new Map(); // `${scopeId}:${pairHash}` -> Set<stateId>
const stateIdsByCommitKey = new Map();

// Local lazily-initialized secret for deterministic but process-private commit keys
const storePrivateSecret = crypto.randomBytes(32);

function getStatesLimit() {
  return MEMORY_CONFIG?.maxSessions || 1000;
}

function getStateTtlMs() {
  return MEMORY_CONFIG?.sessionTtlMs || 30 * 60 * 1000;
}

function debugContinuity(log, message) {
  log?.debug?.("CONTINUITY", message);
}

/**
 * Cleanup expired state snapshots and their indexes.
 */
export function clearExpiredContinuityStates() {
  const now = Date.now();
  const ttl = getStateTtlMs();
  for (const [stateId, state] of statesById) {
    if (now - state.lastUsedAt > ttl) {
      evictState(stateId);
    }
  }
}

/**
 * For testing and resets.
 */
export function clearContinuityStateForTests() {
  statesById.clear();
  pairIndex.clear();
  stateIdsByCommitKey.clear();
}

/**
 * Evict a state snapshot from memory, cleaning all index pointers.
 */
function evictState(stateId) {
  const state = statesById.get(stateId);
  if (!state) return;

  // Clean pair index references
  if (Array.isArray(state.pairWindow)) {
    for (const ph of state.pairWindow) {
      const idxKey = `${state.scopeId}:${ph}`;
      const stateSet = pairIndex.get(idxKey);
      if (stateSet) {
        stateSet.delete(stateId);
        if (stateSet.size === 0) {
          pairIndex.delete(idxKey);
        }
      }
    }
  }

  // Clean commitKey index reference
  if (state.commitKey) {
    stateIdsByCommitKey.delete(state.commitKey);
  }

  statesById.delete(stateId);
}

/**
 * Implements Least Recently Used eviction policy if capacity is reached.
 */
function enforceStateCap() {
  const limit = getStatesLimit();
  if (statesById.size < limit) return;

  let oldestStateId = null;
  let oldestTs = Infinity;
  for (const [sid, state] of statesById) {
    if (state.lastUsedAt < oldestTs) {
      oldestTs = state.lastUsedAt;
      oldestStateId = sid;
    }
  }

  if (oldestStateId) {
    evictState(oldestStateId);
  }
}

/**
 * Ordered continuous suffix score matching.
 */
function suffixScore(incoming, candidateWindow) {
  const max = Math.min(10, incoming.length, candidateWindow.length);
  let score = 0;
  for (let k = 1; k <= max; k += 1) {
    if (incoming[incoming.length - k] !== candidateWindow[candidateWindow.length - k]) {
      break;
    }
    score = k;
  }
  return score;
}

function stableRecordJson(value) {
  return JSON.stringify(value);
}

function textPayload(event) {
  return typeof event?.payload === "string" ? event.payload : null;
}

function outputEventsEquivalent(incoming, stored) {
  if (!Array.isArray(incoming) || !Array.isArray(stored) || incoming.length !== stored.length) return false;
  for (let i = 0; i < incoming.length; i += 1) {
    const a = incoming[i];
    const b = stored[i];
    if (a?.role !== b?.role || a?.kind !== b?.kind) return false;
    const aText = textPayload(a);
    const bText = textPayload(b);
    if (aText !== null || bText !== null) {
      if (aText === null || bText === null) return false;
      if (aText === bText) continue;
      const shorter = aText.length <= bText.length ? aText : bText;
      const longer = aText.length > bText.length ? aText : bText;
      if (shorter.length < 24 || shorter.length / Math.max(1, longer.length) < 0.35 || !longer.includes(shorter)) return false;
      continue;
    }
    if (stableRecordJson(a?.payload) !== stableRecordJson(b?.payload)) return false;
  }
  return true;
}

function driftSuffixScore(incomingRecords, candidateRecords, incomingHashes, candidateHashes) {
  if (!Array.isArray(incomingRecords) || !Array.isArray(candidateRecords)) return 0;
  const max = Math.min(10, incomingRecords.length, candidateRecords.length);
  let score = 0;
  for (let k = 1; k <= max; k += 1) {
    const incomingIndex = incomingRecords.length - k;
    const candidateIndex = candidateRecords.length - k;
    const exactHash = incomingHashes?.[incomingHashes.length - k] === candidateHashes?.[candidateHashes.length - k];
    if (exactHash) {
      score = k;
      continue;
    }
    const incoming = incomingRecords[incomingIndex];
    const candidate = candidateRecords[candidateIndex];
    if (stableRecordJson(incoming?.input) !== stableRecordJson(candidate?.input)) break;
    if (!outputEventsEquivalent(incoming?.output, candidate?.output)) break;
    score = k;
  }
  return score;
}

function resolveOutputDriftState({ scopeId, completedPairHashes, completedPairRecords, log, resultMeta }) {
  if (!Array.isArray(completedPairRecords) || completedPairRecords.length === 0) return null;

  let selectedState = null;
  let maxScore = 0;
  let hasTie = false;
  let candidates = 0;
  const loggedScores = [];

  for (const candidate of statesById.values()) {
    if (candidate.scopeId !== scopeId) continue;
    candidates += 1;
    const score = driftSuffixScore(completedPairRecords, candidate.pairRecords, completedPairHashes, candidate.pairWindow);
    if (score > 0) loggedScores.push(`${candidate.stateId.slice(0, 4)}:${score}`);
    if (score > maxScore) {
      maxScore = score;
      selectedState = candidate;
      hasTie = false;
    } else if (score === maxScore && score > 0) {
      hasTie = true;
    }
  }

  if (!selectedState || hasTie) {
    const reason = hasTie ? "output-drift-tie" : "no-match";
    debugContinuity(log, `[RESOLVE] scope=${scopeId.slice(0, 6)} pairs=${completedPairHashes.length} candidates=${candidates} scores=[${loggedScores.join(",")}] selected=none reason=${reason}`);
    if (resultMeta) { resultMeta.reason = reason; resultMeta.score = maxScore; }
    return null;
  }

  selectedState.lastUsedAt = Date.now();
  debugContinuity(log, `[RESOLVE] scope=${scopeId.slice(0, 6)} pairs=${completedPairHashes.length} candidates=${candidates} scores=[${loggedScores.join(",")}] selected=${selectedState.stateId.slice(0, 4)} reason=output-drift`);
  if (resultMeta) { resultMeta.reason = "output-drift"; resultMeta.score = maxScore; }
  return selectedState;
}

/**
 * Resolve the matching continuity state snapshot.
 *
 * `resultMeta` is an optional mutable object the resolver writes `{ reason, score }`
 * to at each exit point, so the caller can surface a compact reason in info-level
 * logs without changing the return type (which stays `state | null`). It is never
 * used in any identity/hash/storage path — purely for log formatting.
 */
export function resolveContinuityState({ scopeId, completedPairHashes, completedPairRecords, log, resultMeta }) {
  if (!scopeId || !Array.isArray(completedPairHashes) || completedPairHashes.length === 0) {
    debugContinuity(log, `[RESOLVE] scope=${scopeId ? scopeId.slice(0, 6) : "none"} pairs=0 candidates=0 selected=none reason=no-pairs`);
    if (resultMeta) { resultMeta.reason = "no-pairs"; resultMeta.score = 0; }
    return null;
  }

  const lastPairHash = completedPairHashes[completedPairHashes.length - 1];
  const idxKey = `${scopeId}:${lastPairHash}`;
  const candidateStateIds = pairIndex.get(idxKey);
  if (!candidateStateIds || candidateStateIds.size === 0) {
    const driftState = resolveOutputDriftState({ scopeId, completedPairHashes, completedPairRecords, log, resultMeta });
    if (driftState) return driftState;
    debugContinuity(log, `[RESOLVE] scope=${scopeId.slice(0, 6)} pairs=${completedPairHashes.length} lastPair=${lastPairHash.slice(0, 10)} candidates=0 selected=none reason=no-index`);
    if (resultMeta) { resultMeta.reason = "no-match"; resultMeta.score = 0; }
    return null;
  }

  let selectedState = null;
  let maxScore = 0;
  let hasTie = false;
  const loggedScores = [];

  for (const sid of candidateStateIds) {
    const candidate = statesById.get(sid);
    if (!candidate) continue;

    const score = suffixScore(completedPairHashes, candidate.pairWindow);
    loggedScores.push(`${sid.slice(0, 4)}:${score}`);

    if (score > maxScore) {
      maxScore = score;
      selectedState = candidate;
      hasTie = false;
    } else if (score === maxScore && score > 0) {
      hasTie = true;
    }
  }

  if (hasTie || maxScore === 0) {
    const reason = maxScore === 0 ? "zero" : "tie";
    debugContinuity(log, `[RESOLVE] scope=${scopeId.slice(0, 6)} pairs=${completedPairHashes.length} lastPair=${lastPairHash.slice(0, 10)} candidates=${candidateStateIds.size} scores=[${loggedScores.join(",")}] selected=none reason=${reason}`);
    if (resultMeta) { resultMeta.reason = reason; resultMeta.score = maxScore; }
    return null;
  }

  if (selectedState) {
    selectedState.lastUsedAt = Date.now();
    debugContinuity(log, `[RESOLVE] scope=${scopeId.slice(0, 6)} pairs=${completedPairHashes.length} lastPair=${lastPairHash.slice(0, 10)} candidates=${candidateStateIds.size} scores=[${loggedScores.join(",")}] selected=${selectedState.stateId.slice(0, 4)}`);
    if (resultMeta) { resultMeta.reason = "match"; resultMeta.score = maxScore; }
    return selectedState;
  }

  if (resultMeta) { resultMeta.reason = "no-match"; resultMeta.score = 0; }
  return null;
}

/**
 * Commit a new immutable state snapshot or return an existing identical one (idempotent).
 *
 * `resultMeta` is an optional mutable object the caller can use to learn whether the
 * commit created a new state (`result="created"`) or reused an idempotent one
 * (`result="reused"`). It is never used in any identity/hash/storage path — purely
 * for log formatting, so the state snapshot itself stays immutable and free of
 * transient logging metadata.
 */
export function commitContinuityState({ scopeId, parentState, responseThoughts, finalPairWindow, finalPairRecords, continuityCount, log, resultMeta }) {
  if (!scopeId || !Array.isArray(finalPairWindow) || finalPairWindow.length === 0) {
    if (resultMeta) resultMeta.result = "rejected";
    return null;
  }

  const nextThoughts = [
    ...(parentState?.thoughts ?? []),
    ...responseThoughts
  ].slice(-continuityCount);

  // Compute a deterministic commit key to make the commit operation idempotent.
  // Full-length digests — truncating to 64 bits would make an accidental
  // collision merge two unrelated snapshots into one identity. JSON.stringify
  // (not join) preserves element boundaries — join("\n") would collide
  // ["a\nb"] with ["a","b"], silently merging two distinct thought-record
  // sequences into one commitKey.
  const thoughtsDigest = crypto.createHmac("sha256", storePrivateSecret)
    .update(JSON.stringify(nextThoughts))
    .digest("hex");

  const finalWindowDigest = crypto.createHmac("sha256", storePrivateSecret)
    .update(JSON.stringify(finalPairWindow))
    .digest("hex");

  const parentIdStr = parentState?.stateId ?? "ROOT";
  const commitKey = crypto.createHmac("sha256", storePrivateSecret)
    .update(`${scopeId}:${parentIdStr}:${finalWindowDigest}:${thoughtsDigest}`)
    .digest("hex");

  const existingStateId = stateIdsByCommitKey.get(commitKey);
  if (existingStateId) {
    const existingState = statesById.get(existingStateId);
    if (existingState) {
      existingState.lastUsedAt = Date.now();
      if (resultMeta) resultMeta.result = "reused";
      debugContinuity(log, `[COMMIT] scope=${scopeId.slice(0, 6)} parent=${parentIdStr.slice(0, 4)} state=${existingStateId.slice(0, 4)} lastPair=${finalPairWindow[finalPairWindow.length - 1].slice(0, 10)} thoughts=${nextThoughts.length} added=${responseThoughts.length} result=reused-idempotent`);
      return existingState;
    }
  }

  // Enforce memory capacity before writing new state snapshot
  enforceStateCap();

  const stateId = crypto.randomUUID();
  // Dialog anchor: a stable identifier for the dialog that persists across all
  // turns in the chain. Root commits (parentState=null) anchor on their first
  // pair hash; child commits inherit the parent's anchor. This lets info-level
  // logs show a consistent dialog ID that is the same within one dialog and
  // different between different dialogs — without it, the stateId changes
  // every turn (each commit creates a child) and there's no way to tell at a
  // glance whether two requests belong to the same dialog. The anchor is NOT
  // used in any identity/hash/storage path — purely for log correlation.
  const dialogAnchor = parentState?.dialogAnchor ?? finalPairWindow[0].slice(0, 16);
  const newState = {
    stateId,
    scopeId,
    dialogAnchor,
    thoughts: Object.freeze(nextThoughts),
    pairWindow: Object.freeze(finalPairWindow),
    pairRecords: Object.freeze(Array.isArray(finalPairRecords) ? finalPairRecords.slice(-finalPairWindow.length) : []),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    commitKey
  };

  statesById.set(stateId, newState);
  stateIdsByCommitKey.set(commitKey, stateId);

  // Index the state ID by all pairs in its rolling window
  for (const ph of finalPairWindow) {
    const idxKey = `${scopeId}:${ph}`;
    let stateSet = pairIndex.get(idxKey);
    if (!stateSet) {
      stateSet = new Set();
      pairIndex.set(idxKey, stateSet);
    }
    stateSet.add(stateId);
  }

  debugContinuity(log, `[COMMIT] scope=${scopeId.slice(0, 6)} parent=${parentIdStr.slice(0, 4)} state=${stateId.slice(0, 4)} pairs=${finalPairWindow.length} lastPair=${finalPairWindow[finalPairWindow.length - 1].slice(0, 10)} thoughts=${nextThoughts.length} added=${responseThoughts.length} result=created`);
  if (resultMeta) resultMeta.result = "created";
  return newState;
}

/**
 * Compose canonicalizer + store for the common "response finished" call site:
 * turn the client's incoming history plus this turn's client-facing output
 * into a final pair window, filter oversize thought records, and commit.
 * Shared by the non-streaming, forced-SSE-to-JSON, and streaming handlers so
 * none of them duplicate resolver/store composition logic.
 *
 * Also emits the info-level [CAPTURE] and [STORE] summaries when new thought
 * records survived filtering. The verbose [COMMIT-SHAPE]/[COMMIT-PAIR]/[COMMIT]
 * debug traces remain unchanged — this only adds the compact info summaries
 * alongside them.
 *
 * @param {object} continuityCtx - { scopeId, incomingEvents, resolvedState, continuityCount, log, requestLogToken, responseSource }
 * @param {string[]} responseThoughts - ordered thought text records for this turn
 * @param {object[]} clientOutputEvents - canonical events for the final client-facing output
 */
export function commitContinuityFromClientOutput({ continuityCtx, responseThoughts, clientOutputEvents }) {
  if (!continuityCtx?.scopeId) return null;
  if (!Array.isArray(clientOutputEvents) || clientOutputEvents.length === 0) return null;

  const history = [...continuityCtx.incomingEvents, ...clientOutputEvents];
  const analysis = analyzeContinuityHistory(history, continuityCtx.scopeId);
  if (!analysis.canCommit) return null;
  const finalPairs = analysis.pairHashes;
  const finalPairWindow = buildPairWindow(finalPairs);
  if (finalPairWindow.length === 0) return null;

  const filteredThoughts = filterOversizeThoughts(responseThoughts);
  const thoughtsAdded = Array.isArray(filteredThoughts) ? filteredThoughts.length : 0;
  const captureChars = thoughtsAdded > 0 ? filteredThoughts.reduce((s, t) => s + (typeof t === "string" ? t.length : 0), 0) : 0;

  // Info-level capture summary — only when new thoughts survived filtering.
  if (thoughtsAdded > 0 && continuityCtx.requestLogToken) {
    logContinuityCapture(continuityCtx.log, {
      token: continuityCtx.requestLogToken,
      thoughtsCount: thoughtsAdded,
      chars: captureChars,
      source: continuityCtx.responseSource || "json"
    });
  }

  // Diagnostic traces — per-event digests with payload summaries.
  // [COMMIT-PAIR]: last completed pair's event digests (legacy, kept for compat).
  // [CANONICAL-OUT]: all output events with digests + summaries — see exactly what
  //   the client will see and what gets fingerprinted into the new pair.
  // [PAIR-CHAIN-OUT]: all completed pairs after this commit, with real pair hashes
  //   and per-event digests — the full fingerprint chain the next request will be
  //   scored against.
  // [TOOL-LINKAGE-OUT]: tool call/result linking after normalization — see which
  //   results linked to which calls, which are unlinked barriers.
  debugContinuity(continuityCtx.log, `[COMMIT-PAIR] scope=${continuityCtx.scopeId.slice(0, 6)} ${describeLastCompletedPair(history)}`);
  debugContinuity(continuityCtx.log, `[CANONICAL-OUT] scope=${continuityCtx.scopeId.slice(0, 6)} ${describeAllEvents(clientOutputEvents)}`);
  debugContinuity(continuityCtx.log, `[PAIR-CHAIN-OUT] scope=${continuityCtx.scopeId.slice(0, 6)} ${describeAllPairs(history, continuityCtx.scopeId)}`);
  debugContinuity(continuityCtx.log, `[TOOL-LINKAGE-OUT] scope=${continuityCtx.scopeId.slice(0, 6)} ${describeToolLinkage(history)}`);

  const commitMeta = {};
  const committed = commitContinuityState({
    scopeId: continuityCtx.scopeId,
    parentState: continuityCtx.resolvedState,
    responseThoughts: filteredThoughts,
    finalPairWindow,
    finalPairRecords: analysis.postBarrierRecords,
    continuityCount: continuityCtx.continuityCount,
    log: continuityCtx.log,
    resultMeta: commitMeta
  });

  // Info-level store summary — fires on every successful commit so the `dialog=`
  // anchor is always visible at info level, even for turns that capture no new
  // thoughts (e.g. codex/openai-responses turns that don't extract thinking segments).
  // `thoughtsAdded` reflects whether new records actually entered the store: an
  // idempotent reused commit reports 0, and turns with no thinking output report 0.
  // `dialogAnchor` is the stable dialog ID (same across all turns in the chain,
  // different between dialogs) — derived from the root pair hash and inherited
  // through child states.
  if (committed && continuityCtx.requestLogToken) {
    const result = commitMeta.result || "created";
    logContinuityStore(continuityCtx.log, {
      token: continuityCtx.requestLogToken,
      stateId: committed.stateId,
      dialogAnchor: committed.dialogAnchor,
      parentId: continuityCtx.resolvedState?.stateId,
      pairs: finalPairWindow.length,
      lastPair: finalPairWindow[finalPairWindow.length - 1],
      thoughtsAdded: result === "reused" ? 0 : thoughtsAdded,
      thoughtsCaptured: thoughtsAdded,
      result
    });
  }

  return committed;
}

// Periodically run cleanup interval
const interval = setInterval(clearExpiredContinuityStates, MEMORY_CONFIG?.sessionCleanupIntervalMs || 5 * 60 * 1000);
if (interval.unref) interval.unref();
