import { createHash } from "node:crypto";

import { DefaultExecutor } from "./default.js";

const FOREIGN_REASONING_ERROR = "reasoning `encrypted_content` was not issued to this caller";
const EXPIRED_REASONING_REFERENCE = /Referenced reasoning item '([^']+)' was not found or has expired/;
const MAX_TRACKED_CALLERS = 64;
const MAX_TRACKED_HASHES_PER_CALLER = 10000;
const MAX_RECOVERY_ATTEMPTS = 4;

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
 * is removed for a recovery attempt after Meta has identified a mismatch.
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

/**
 * Last-resort recovery: drop prior reasoning items entirely instead of
 * replaying them summary-only. Caller-bound encrypted payloads on other
 * item types are stripped as in sanitizeMuseForeignReasoning. The rest of
 * the history (messages, function calls and outputs) is preserved, so a
 * tool-calling loop can continue without its encrypted continuity state.
 */
export function dropMuseReasoningItems(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input)) {
    return { body, removedItems: 0, removedHashes: [] };
  }

  const sanitized = sanitizeMuseForeignReasoning(body);
  const input = sanitized.body.input.filter((item) => item?.type !== "reasoning");
  const removedItems = sanitized.body.input.length - input.length;
  if (!removedItems && !sanitized.removedHashes.length) {
    return { body, removedItems: 0, removedHashes: [] };
  }

  return {
    body: { ...sanitized.body, input },
    removedItems,
    removedHashes: sanitized.removedHashes,
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
    let body = knownForeignHashes
      ? sanitizeMuseForeignReasoning(args.body, knownForeignHashes).body
      : args.body;
    if (knownExpiredReferences) {
      body = dropMuseReasoningReferences(body, knownExpiredReferences).body;
    }

    // Recovery is a bounded ladder, not a single retry: strip the encrypted
    // payloads (keeping summaries), then drop the prior reasoning items
    // entirely, dropping server-side references whenever Meta names one.
    // Each rung runs only after Meta rejected the previous form, and only
    // while it changes the body. The outcome of a recovery attempt is never
    // masked by the original rejection: a newer upstream error is the one
    // returned, and a transport failure propagates so account fallback can
    // try another caller (possibly the one that issued the blobs) instead
    // of the request being filed as an unrecoverable request-scoped 400.
    let strippedEncrypted = false;
    let droppedReasoning = false;
    for (let recoveries = 0; ; recoveries++) {
      const result = await super.execute({ ...args, body });

      if (result.response?.status !== 400 || typeof result.response.clone !== "function"
        || recoveries >= MAX_RECOVERY_ATTEMPTS) {
        return result;
      }

      let errorText = "";
      try {
        errorText = await result.response.clone().text();
      } catch {
        return result;
      }

      const expiredMatch = errorText.match(EXPIRED_REASONING_REFERENCE);
      if (expiredMatch) {
        const dropped = dropMuseReasoningReferences(body, new Set([expiredMatch[1]]));
        if (dropped.removedIds.length) {
          this._rememberExpiredReferences(scope, dropped.removedIds);
          args.log?.warn?.(
            "RETRY",
            `MUSE | expired reasoning reference rejected; retrying without ${dropped.removedIds.length} referenced item(s)`,
          );
          body = dropped.body;
          continue;
        }
        // The named reference is not a top-level reasoning id in this body;
        // fall through to dropping the reasoning items outright.
        if (!droppedReasoning) {
          const droppedAll = dropMuseReasoningItems(body);
          droppedReasoning = true;
          if (droppedAll.removedItems || droppedAll.removedHashes.length) {
            this._rememberForeignHashes(scope, droppedAll.removedHashes);
            args.log?.warn?.(
              "RETRY",
              `MUSE | expired reasoning reference has no droppable id; retrying without ${droppedAll.removedItems} reasoning item(s)`,
            );
            body = droppedAll.body;
            continue;
          }
        }
        return result;
      }

      if (!errorText.includes(FOREIGN_REASONING_ERROR)) return result;

      if (!strippedEncrypted) {
        const sanitized = sanitizeMuseForeignReasoning(body);
        strippedEncrypted = true;
        if (sanitized.removedHashes.length) {
          this._rememberForeignHashes(scope, sanitized.removedHashes);
          args.log?.warn?.(
            "RETRY",
            `MUSE | foreign reasoning state rejected; retrying without ${sanitized.removedHashes.length} encrypted item(s)`,
          );
          body = sanitized.body;
          continue;
        }
      }

      if (!droppedReasoning) {
        const droppedAll = dropMuseReasoningItems(body);
        droppedReasoning = true;
        if (droppedAll.removedItems || droppedAll.removedHashes.length) {
          this._rememberForeignHashes(scope, droppedAll.removedHashes);
          args.log?.warn?.(
            "RETRY",
            `MUSE | foreign reasoning state still rejected; retrying without ${droppedAll.removedItems} reasoning item(s)`,
          );
          body = droppedAll.body;
          continue;
        }
      }

      return result;
    }
  }
}

export default MuseExecutor;
