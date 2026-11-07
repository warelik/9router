import { createHash } from "node:crypto";

import { DefaultExecutor } from "./default.js";

const FOREIGN_REASONING_ERROR = "reasoning `encrypted_content` was not issued to this caller";
const EXPIRED_REASONING_REFERENCE = /Referenced reasoning item '([^']+)' was not found or has expired/;
const MAX_TRACKED_CALLERS = 64;
const MAX_TRACKED_HASHES_PER_CALLER = 10000;

function hashValue(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encryptedValues(item) {
  return [
    item?.encrypted_content,
    item?.reasoning_encrypted_content,
    item?.reasoning?.encrypted_content,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function hasSummary(item) {
  return Array.isArray(item?.summary)
    && item.summary.some((part) => typeof part?.text === "string" && part.text.length > 0);
}

function hasContent(item) {
  return Array.isArray(item?.content) && item.content.length > 0;
}

/**
 * Remove caller-bound encrypted reasoning payloads while preserving the rest
 * of the Responses history. Reasoning items keep their summary/content when
 * present; items that consisted only of the encrypted continuity blob are
 * dropped because an anonymous empty reasoning item carries no usable state.
 *
 * When incompatibleHashes is provided, only payloads already known to be
 * rejected for this caller are removed. Without it, every encrypted payload
 * is removed for the one recovery attempt after Meta has identified a
 * mismatch.
 */
export function sanitizeMuseForeignReasoning(body, incompatibleHashes = null) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input)) {
    return { body, removedHashes: [] };
  }

  let changed = false;
  const removedHashes = [];
  const input = [];

  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      input.push(item);
      continue;
    }

    const hashes = encryptedValues(item).map(hashValue);
    if (!hashes.length || (incompatibleHashes && !hashes.some((hash) => incompatibleHashes.has(hash)))) {
      input.push(item);
      continue;
    }

    changed = true;
    removedHashes.push(...hashes);

    const clean = { ...item };
    delete clean.encrypted_content;
    delete clean.reasoning_encrypted_content;
    if (clean.reasoning && typeof clean.reasoning === "object" && !Array.isArray(clean.reasoning)) {
      clean.reasoning = { ...clean.reasoning };
      delete clean.reasoning.encrypted_content;
    }

    if (item.type !== "reasoning") {
      input.push(clean);
      continue;
    }

    // The id identifies the stored item issued under the previous caller.
    // Keep only portable summary/content once its encrypted state is removed.
    delete clean.id;
    if (hasSummary(clean) || hasContent(clean)) input.push(clean);
  }

  return {
    body: changed ? { ...body, input } : body,
    removedHashes,
  };
}

/**
 * Remove reasoning items whose server-side reference Meta no longer holds.
 * The referenced form carries only an id (plus summary); without the stored
 * object the caller cannot resolve it, so keep the portable summary/content
 * when present and drop the id, dropping the item when nothing usable remains.
 */
export function dropMuseReasoningReferences(body, referencedIds) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input)
    || !(referencedIds instanceof Set) || !referencedIds.size) {
    return { body, removedIds: [] };
  }

  let changed = false;
  const removedIds = [];
  const input = [];

  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || item.type !== "reasoning" || !referencedIds.has(item.id)) {
      input.push(item);
      continue;
    }

    changed = true;
    removedIds.push(item.id);
    const clean = { ...item };
    delete clean.id;
    if (hasSummary(clean) || hasContent(clean)) input.push(clean);
  }

  return {
    body: changed ? { ...body, input } : body,
    removedIds,
  };
}

export class MuseExecutor extends DefaultExecutor {
  constructor() {
    super("muse");
    this._foreignReasoningByScope = new Map();
    this._expiredReferencesByScope = new Map();
  }

  _callerScope(args) {
    const credentials = args?.credentials || {};
    const secret = credentials.accessToken || credentials.apiKey || "";
    return secret
      ? hashValue(String(secret))
      : (credentials.connectionId || "unknown-caller");
  }

  _knownForeignHashes(scope) {
    const known = this._foreignReasoningByScope.get(scope);
    if (!known) return null;
    // Refresh LRU position; a session can legitimately run for many turns.
    this._foreignReasoningByScope.delete(scope);
    this._foreignReasoningByScope.set(scope, known);
    return known;
  }

  _rememberForeignHashes(scope, hashes) {
    if (!hashes.length) return;
    let known = this._foreignReasoningByScope.get(scope);
    if (!known) {
      known = new Set();
      this._foreignReasoningByScope.set(scope, known);
    }
    for (const hash of hashes) known.add(hash);
    while (known.size > MAX_TRACKED_HASHES_PER_CALLER) {
      known.delete(known.values().next().value);
    }

    while (this._foreignReasoningByScope.size > MAX_TRACKED_CALLERS) {
      const oldest = this._foreignReasoningByScope.keys().next().value;
      this._foreignReasoningByScope.delete(oldest);
    }
  }

  _knownExpiredReferences(scope) {
    const known = this._expiredReferencesByScope.get(scope);
    if (!known) return null;
    this._expiredReferencesByScope.delete(scope);
    this._expiredReferencesByScope.set(scope, known);
    return known;
  }

  _rememberExpiredReferences(scope, ids) {
    if (!ids.length) return;
    let known = this._expiredReferencesByScope.get(scope);
    if (!known) {
      known = new Set();
      this._expiredReferencesByScope.set(scope, known);
    }
    for (const id of ids) known.add(id);
    while (known.size > MAX_TRACKED_HASHES_PER_CALLER) {
      known.delete(known.values().next().value);
    }

    while (this._expiredReferencesByScope.size > MAX_TRACKED_CALLERS) {
      const oldest = this._expiredReferencesByScope.keys().next().value;
      this._expiredReferencesByScope.delete(oldest);
    }
  }

  async execute(args) {
    const scope = this._callerScope(args);
    const knownForeignHashes = this._knownForeignHashes(scope);
    const knownExpiredReferences = this._knownExpiredReferences(scope);
    let preparedBody = knownForeignHashes
      ? sanitizeMuseForeignReasoning(args.body, knownForeignHashes).body
      : args.body;
    if (knownExpiredReferences) {
      preparedBody = dropMuseReasoningReferences(preparedBody, knownExpiredReferences).body;
    }
    const first = await this._executeRecovering({ ...args, body: preparedBody }, scope, false);
    return first;
  }

  async _executeRecovering(args, scope, retried) {
    const first = await super.execute(args);

    if (retried || first.response?.status !== 400 || typeof first.response.clone !== "function") {
      return first;
    }

    let errorText = "";
    try {
      errorText = await first.response.clone().text();
    } catch {
      return first;
    }

    const expiredMatch = errorText.match(EXPIRED_REASONING_REFERENCE);
    if (expiredMatch) {
      const dropped = dropMuseReasoningReferences(args.body, new Set([expiredMatch[1]]));
      if (!dropped.removedIds.length) return first;

      this._rememberExpiredReferences(scope, dropped.removedIds);
      args.log?.warn?.(
        "RETRY",
        `MUSE | expired reasoning reference rejected; retrying without ${dropped.removedIds.length} referenced item(s)`,
      );

      try {
        const retry = await this._executeRecovering({ ...args, body: dropped.body }, scope, true);
        return retry.response?.ok || (retry.response && retry.response.status !== 400)
          ? retry
          : first;
      } catch {
        return first;
      }
    }

    if (!errorText.includes(FOREIGN_REASONING_ERROR)) return first;

    const sanitized = sanitizeMuseForeignReasoning(args.body);
    if (!sanitized.removedHashes.length) return first;

    this._rememberForeignHashes(scope, sanitized.removedHashes);
    args.log?.warn?.(
      "RETRY",
      `MUSE | foreign reasoning state rejected; retrying without ${sanitized.removedHashes.length} encrypted item(s)`,
    );

    try {
      const retry = await this._executeRecovering({ ...args, body: sanitized.body }, scope, true);
      return retry.response?.ok || (retry.response && retry.response.status !== 400)
        ? retry
        : first;
    } catch {
      return first;
    }
  }
}

export default MuseExecutor;
