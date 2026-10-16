import { createHash } from "node:crypto";
import { makeKv } from "../../src/lib/db/helpers/kvStore.js";

const MAX_SIGNATURES = 2000;
const MAX_PERSISTED_SIGNATURES = 10_000;
const MEMORY_TTL_MS = 1000 * 60 * 60; // 1 hour
const PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SCOPE = "gemini_thought_signatures";

const signatureKv = makeKv(SCOPE);
const memorySignatures = new Map();
let pruneCounter = 0;

/**
 * Model family that produced / will consume a signature. Antigravity serves Gemini and Claude
 * models behind the same API, and each backend only accepts its own signatures: a Claude
 * signature replayed to Gemini fails with 400 "Corrupted thought signature." (and vice versa).
 */
export function signatureFamily(model) {
  const m = typeof model === "string" ? model.toLowerCase() : "";
  if (!m) return null;
  if (m.includes("claude")) return "claude";
  if (m.includes("gemini")) return "gemini";
  return m;
}

// Entries stored before families were recorded (no `family`) stay usable for any model.
function isCompatible(entry, family) {
  return !entry.family || !family || entry.family === family;
}

function pruneMemoryExpired() {
  const now = Date.now();
  for (const [key, value] of memorySignatures.entries()) {
    if (value.expiresAt <= now) {
      memorySignatures.delete(key);
    }
  }

  while (memorySignatures.size > MAX_SIGNATURES) {
    const oldestKey = memorySignatures.keys().next().value;
    if (!oldestKey) break;
    memorySignatures.delete(oldestKey);
  }
}

async function maybePrunePersisted() {
  pruneCounter++;
  if (pruneCounter % 100 !== 0) return;

  try {
    const all = await signatureKv.getAll();
    const keys = Object.keys(all);
    const now = Date.now();
    const expiredKeys = [];
    const valid = [];

    for (const k of keys) {
      const entry = all[k];
      if (!entry || typeof entry.signature !== "string" || (entry.expiresAt && entry.expiresAt <= now)) {
        expiredKeys.push(k);
      } else {
        valid.push({ key: k, createdAt: entry.createdAt || 0 });
      }
    }

    for (const k of expiredKeys) {
      await signatureKv.remove(k).catch(() => {});
    }

    if (valid.length > MAX_PERSISTED_SIGNATURES) {
      valid.sort((a, b) => b.createdAt - a.createdAt);
      const toRemove = valid.slice(MAX_PERSISTED_SIGNATURES);
      for (const item of toRemove) {
        await signatureKv.remove(item.key).catch(() => {});
      }
    }
  } catch {
    // Fail-open
  }
}

/**
 * Store a thought signature for a tool_call_id with optional sessionId namespace (RAM + SQLite async).
 * `model` is the model that produced the signature; lookups for another model family skip it.
 */
export function storeGeminiThoughtSignature(toolCallId, signature, sessionId = null, model = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (typeof signature !== "string" || !signature) return;

  const now = Date.now();
  const family = signatureFamily(model);
  pruneMemoryExpired();

  const keys = [];
  if (sessionId && typeof sessionId === "string") {
    keys.push(`${sessionId}:${toolCallId}`);
  }
  keys.push(toolCallId);

  for (const k of keys) {
    memorySignatures.set(k, {
      signature,
      family,
      expiresAt: now + MEMORY_TTL_MS,
    });

    // Async persist to SQLite kv table without blocking
    signatureKv.set(k, {
      signature,
      family,
      createdAt: now,
      expiresAt: now + PERSISTED_TTL_MS,
    }).catch(() => {});
  }

  maybePrunePersisted().catch(() => {});
}

/**
 * Retrieve a thought signature by tool_call_id (RAM first, then SQLite fallback).
 * `model` is the target model; signatures produced by another model family are ignored.
 */
export async function getGeminiThoughtSignature(toolCallId, sessionId = null, model = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;

  const family = signatureFamily(model);
  pruneMemoryExpired();

  if (sessionId && typeof sessionId === "string") {
    const sessionKey = `${sessionId}:${toolCallId}`;
    const sessionEntry = memorySignatures.get(sessionKey);
    if (sessionEntry && sessionEntry.expiresAt > Date.now() && isCompatible(sessionEntry, family)) {
      return sessionEntry.signature;
    }
  }

  const entry = memorySignatures.get(toolCallId);
  if (entry && entry.expiresAt > Date.now() && isCompatible(entry, family)) {
    return entry.signature;
  }

  try {
    if (sessionId && typeof sessionId === "string") {
      const sessionKey = `${sessionId}:${toolCallId}`;
      const sessionRow = await signatureKv.get(sessionKey);
      if (sessionRow && typeof sessionRow.signature === "string" && (!sessionRow.expiresAt || sessionRow.expiresAt > Date.now()) && isCompatible(sessionRow, family)) {
        memorySignatures.set(sessionKey, {
          signature: sessionRow.signature,
          family: sessionRow.family || null,
          expiresAt: Date.now() + MEMORY_TTL_MS,
        });
        return sessionRow.signature;
      }
    }

    const row = await signatureKv.get(toolCallId);
    if (row && typeof row.signature === "string") {
      if (row.expiresAt && row.expiresAt <= Date.now()) {
        signatureKv.remove(toolCallId).catch(() => {});
        return null;
      }
      if (!isCompatible(row, family)) return null;
      memorySignatures.set(toolCallId, {
        signature: row.signature,
        family: row.family || null,
        expiresAt: Date.now() + MEMORY_TTL_MS,
      });
      return row.signature;
    }
  } catch {
    // Fail-open
  }

  return null;
}

/**
 * Synchronous get from RAM cache only (for sync translators).
 * `model` is the target model; signatures produced by another model family are ignored.
 */
export function getGeminiThoughtSignatureSync(toolCallId, sessionId = null, model = null) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  const family = signatureFamily(model);
  pruneMemoryExpired();

  if (sessionId && typeof sessionId === "string") {
    const sessionKey = `${sessionId}:${toolCallId}`;
    const sessionEntry = memorySignatures.get(sessionKey);
    if (sessionEntry && sessionEntry.expiresAt > Date.now() && isCompatible(sessionEntry, family)) {
      return sessionEntry.signature;
    }
  }

  const entry = memorySignatures.get(toolCallId);
  if (entry && entry.expiresAt > Date.now() && isCompatible(entry, family)) {
    return entry.signature;
  }
  return null;
}

/**
 * Conversation identity for turn signatures: everything stable that gives a turn its context -
 * the system instruction and, per part, roles, texts, tool call ids, tool names, call arguments, tool results
 * and inline data. Only what differs between a turn and its echo is left out: thought parts and
 * signatures. It is computed from the request that produced a turn and, later, from the history
 * preceding that turn in the next request, so both sides agree even though normalisation merges
 * messages.
 */
export function geminiTurnScope(contents, systemInstruction = null) {
  if (!Array.isArray(contents)) return null;
  const h = createHash("sha256");
  const put = (...items) => h.update(`${items.join("\u0001")}\u0000`);
  for (const p of systemInstruction?.parts || []) {
    if (typeof p?.text === "string" && p.text.trim()) put("sys", p.text.trim());
  }
  for (const c of contents) {
    for (const p of c?.parts || []) {
      if (p?.functionCall) put(c.role, "fc", p.functionCall.id ?? "", p.functionCall.name, JSON.stringify(p.functionCall.args ?? {}));
      else if (p?.functionResponse) put(c.role, "fr", p.functionResponse.id ?? "", p.functionResponse.name, JSON.stringify(p.functionResponse.response ?? {}));
      else if (p?.inlineData || p?.inline_data) put(c.role, "inline", JSON.stringify(p.inlineData || p.inline_data));
      else if (p?.fileData || p?.file_data) put(c.role, "file", JSON.stringify(p.fileData || p.file_data));
      else if (!p?.thought && typeof p?.text === "string" && p.text.trim()) put(c.role, "t", p.text.trim());
    }
  }
  return h.digest("hex");
}

/**
 * Signatures of assistant turns without a tool call. Clients echo the turn back as plain
 * reasoning/content text and never see the signature, so the turn is keyed by its text within
 * its conversation scope: `r` = reasoning (thought summary) text, `c` = visible answer text.
 * Both are stored when present so the lookup works for clients that drop either of them.
 * The same text in a different conversation prefix never matches.
 */
function turnKey(kind, text, scope) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized || !scope) return null;
  const digest = createHash("sha256").update(`${scope}\0${kind}\0${normalized}`).digest("hex");
  return `turn:${digest}`;
}

export function storeGeminiTurnSignature({ reasoning, content, scope }, signature, model = null) {
  for (const key of [turnKey("r", reasoning, scope), turnKey("c", content, scope)]) {
    if (key) storeGeminiThoughtSignature(key, signature, null, model);
  }
}

export function findGeminiTurnSignature({ reasoning, content, scope }, model = null) {
  for (const key of [turnKey("r", reasoning, scope), turnKey("c", content, scope)]) {
    const sig = key ? getGeminiThoughtSignatureSync(key, null, model) : null;
    if (sig) return sig;
  }
  return null;
}

const SERVER_PARTS_PREFIX = "serverparts:";

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

// Server-side tool parts are plaintext conversation data: they are only ever addressed
// by session AND conversation scope AND anchor, never by the anchor alone.
function serverPartsKey(anchorId, sessionId, scope) {
  if (!isNonEmptyString(anchorId) || !isNonEmptyString(sessionId) || !isNonEmptyString(scope)) return null;
  return `${SERVER_PARTS_PREFIX}${createHash("sha256").update(JSON.stringify([sessionId, scope, anchorId])).digest("hex")}`;
}

function decodeServerParts(raw) {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Server-side tool parts (toolCall/toolResponse, e.g. googleSearch on Gemini 3) anchored to the
 * functionCall they precede. Stored as a JSON string so the shared KV prune keeps working.
 */
export function storeGeminiServerParts(anchorId, parts, sessionId = null, model = null, scope = null) {
  const key = serverPartsKey(anchorId, sessionId, scope);
  if (!key || !Array.isArray(parts) || parts.length === 0) return;
  storeGeminiThoughtSignature(key, JSON.stringify(parts), null, model);
}

export function getGeminiServerPartsSync(anchorId, sessionId = null, model = null, scope = null) {
  const key = serverPartsKey(anchorId, sessionId, scope);
  return key ? decodeServerParts(getGeminiThoughtSignatureSync(key, null, model)) : null;
}

/**
 * Same anchoring as storeGeminiTurnSignature: a turn that ends in text has no call id, so the
 * parts are keyed by the turn's reasoning/content text inside its conversation scope.
 */
export function storeGeminiServerPartsForTurn({ reasoning, content, scope, sessionId = null }, parts, model = null) {
  if (!Array.isArray(parts) || parts.length === 0) return;
  for (const anchor of [turnKey("r", reasoning, scope), turnKey("c", content, scope)]) {
    const key = serverPartsKey(anchor, sessionId, scope);
    if (key) storeGeminiThoughtSignature(key, JSON.stringify(parts), null, model);
  }
}

export function findGeminiServerPartsForTurn({ reasoning, content, scope, sessionId = null }, model = null) {
  for (const anchor of [turnKey("r", reasoning, scope), turnKey("c", content, scope)]) {
    const key = serverPartsKey(anchor, sessionId, scope);
    const parts = key ? decodeServerParts(getGeminiThoughtSignatureSync(key, null, model)) : null;
    if (parts) return parts;
  }
  return null;
}
