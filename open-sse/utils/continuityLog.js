/**
 * Compact info-level continuity log formatters.
 *
 * These emit ONLY operational metadata — counts, short digest prefixes, state/scope
 * prefixes, dialog anchors, and reason codes. They NEVER log raw prompt text,
 * reasoning content, tool arguments, transport IDs, or API keys.
 *
 * The `dialog` field is a stable dialog identifier (first 8 chars of the dialog
 * anchor) that is the same across all turns within one dialog and different between
 * different dialogs. It is derived from the root pair hash and inherited through
 * the state chain. For a first-turn (ROOT) request, dialog=NEW; for a no-match,
 * dialog=? (the dialog could not be identified).
 *
 * The verbose diagnostic traces ([LOOKUP], [LOOKUP-PAIR], [RESOLVE], [COMMIT-SHAPE],
 * [COMMIT-PAIR], [CANONICAL-IN], [PAIR-CHAIN], [TOOL-LINKAGE], [CANONICAL-OUT],
 * [PAIR-CHAIN-OUT], [TOOL-LINKAGE-OUT]) remain debug-only in their existing call
 * sites — this module adds the info-level summaries alongside them, it does not
 * replace or shorten the debug payloads.
 *
 * `req` is a process-local request trace token used solely for log correlation across
 * combo attempts and response handlers. It is NOT a session/dialog identity, never
 * participates in scope derivation, pair hashing, resolver scoring, commit idempotency,
 * state IDs, storage keys, routing, or request body mutation.
 */

function safeAtom(value) {
  if (value == null || value === "") return "none";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return "set";
  const compact = value.replace(/\s+/g, "_").slice(0, 32);
  return /^[\w.:-]+$/.test(compact) ? compact : "set";
}

export function describeThinkingParams(body) {
  if (!body || typeof body !== "object") return "effort=none,thinking=none";
  const parts = [`effort=${safeAtom(body.reasoning_effort ?? body.reasoning?.effort)}`];
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object") {
    const type = safeAtom(thinking.type || "object");
    parts.push(`thinking=${type}`);
    const budget = safeAtom(thinking.budget_tokens ?? thinking.budgetTokens ?? thinking.budget);
    if (budget !== "none") parts.push(`budget=${budget}`);
    const interval = safeAtom(thinking.interval ?? thinking.interval_tokens ?? thinking.thinking_interval);
    if (interval !== "none") parts.push(`interval=${interval}`);
    if (thinking.type === "adaptive" || thinking.adaptive === true) parts.push("adaptive=on");
  } else {
    parts.push(`thinking=${safeAtom(thinking)}`);
  }
  const outputEffort = safeAtom(body.output_config?.effort);
  if (outputEffort !== "none") parts.push(`outputEffort=${outputEffort}`);
  return parts.join(",");
}

/**
 * One compact line per logical inbound client request, emitted after canonicalization
 * and resolve, before provider execution. Deduplicated across combo/fallback attempts
 * by the caller via a shared `requestLogCtx` flag.
 */
export function logContinuityRequest(log, ctx) {
  if (!log?.info) return;
  const scope = ctx.scopeId ? ctx.scopeId.slice(0, 6) : "none";
  const lastPair = ctx.lastPair ? ctx.lastPair.slice(0, 10) : "none";
  // Dialog anchor: stable across all turns in one dialog, different between dialogs.
  // resolvedState carries the anchor from the committed state chain; ROOT means
  // first turn (anchor will be assigned on commit); no-match means unidentified.
  let dialogField;
  let resolvedField;
  if (ctx.reason === "barrier") {
    dialogField = "?";
    resolvedField = "none reason=barrier";
  } else if (ctx.pairsCount === 0) {
    dialogField = "NEW";
    resolvedField = "ROOT";
  } else if (ctx.resolvedState) {
    dialogField = ctx.resolvedState.dialogAnchor ? ctx.resolvedState.dialogAnchor.slice(0, 8) : "?";
    resolvedField = `${ctx.resolvedState.stateId.slice(0, 4)} score=${ctx.resolveScore ?? 0}`;
  } else {
    dialogField = "?";
    resolvedField = `none reason=${ctx.reason || "no-match"}`;
  }
  log.info("CONTINUITY", `[REQUEST] req=${ctx.token} dialog=${dialogField} scope=${scope} format=${ctx.sourceFormat} events=${ctx.eventsCount} pairs=${ctx.pairsCount} lastPair=${lastPair} resolved=${resolvedField} clientThinking=${ctx.clientThinking || "effort=none,thinking=none"}`);
}

/**
 * Dispatch summary — emitted once per logical client request after the provider-level
 * thinking override, translation, and token-saver passes, right before executor dispatch.
 * Shows the final thinking/effort params that actually fly to the provider, so the
 * info-level log trail captures both what the client sent ([REQUEST]) and what the
 * provider received ([DISPATCH]).
 */
export function logContinuityDispatch(log, ctx) {
  if (!log?.info) return;
  const scope = ctx.scopeId ? ctx.scopeId.slice(0, 6) : "none";
  const dialog = ctx.dialogAnchor ? ctx.dialogAnchor.slice(0, 8) : (ctx.isNew ? "NEW" : "?");
  log.info("CONTINUITY", `[DISPATCH] req=${ctx.token} dialog=${dialog} scope=${scope} provider=${ctx.provider || "?"} model=${ctx.model || "?"} stream=${ctx.stream ? "on" : "off"} override=${safeAtom(ctx.overrideMode || "auto")} providerThinking=${ctx.providerThinking || "effort=none,thinking=none"}`);
}

/**
 * Thought capture summary — emitted only when at least one new thought record survived
 * oversize filtering. `chars` is the total character count of the filtered records,
 * never the raw thought text.
 */
export function logContinuityCapture(log, ctx) {
  if (!log?.info) return;
  if (!ctx.thoughtsCount || ctx.thoughtsCount === 0) return;
  log.info("CONTINUITY", `[CAPTURE] req=${ctx.token} thoughts=${ctx.thoughtsCount} chars=${ctx.chars} source=${ctx.source}`);
}

/**
 * State store summary — emitted on every successful commit so the `dialog=` anchor
 * is always visible at info level, even for turns that capture no new thoughts.
 * `thoughtsAdded` is the count of new records that actually entered the store
 * (0 for an idempotent reused commit or a turn with no thinking output);
 * `thoughtsCaptured` is the count of thought records this turn produced after
 * oversize filtering. `result` is "created" or "reused" (idempotent).
 */
export function logContinuityStore(log, ctx) {
  if (!log?.info) return;
  const state = ctx.stateId ? ctx.stateId.slice(0, 4) : "none";
  const dialog = ctx.dialogAnchor ? ctx.dialogAnchor.slice(0, 8) : "?";
  const parent = ctx.parentId ? ctx.parentId.slice(0, 4) : "ROOT";
  const lastPair = ctx.lastPair ? ctx.lastPair.slice(0, 10) : "none";
  log.info("CONTINUITY", `[STORE] req=${ctx.token} dialog=${dialog} state=${state} parent=${parent} pairs=${ctx.pairs} lastPair=${lastPair} thoughtsAdded=${ctx.thoughtsAdded} thoughtsCaptured=${ctx.thoughtsCaptured} result=${ctx.result}`);
}

/**
 * Inject summary — emitted for each real inject of framed thoughts into the system
 * prompt. `sourceState` is the state the thoughts were read from; `target` is the
 * provider target format. `chars` is the total injected text size after budgeting.
 */
export function logContinuityInject(log, ctx) {
  if (!log?.info) return;
  if (!ctx.thoughtsCount || ctx.thoughtsCount === 0) return;
  const state = ctx.sourceStateId ? ctx.sourceStateId.slice(0, 4) : "none";
  const dialog = ctx.dialogAnchor ? ctx.dialogAnchor.slice(0, 8) : "?";
  log.info("CONTINUITY", `[INJECT] req=${ctx.token} dialog=${dialog} sourceState=${state} thoughts=${ctx.thoughtsCount} chars=${ctx.chars} target=${ctx.target}`);
}
