import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureConversationId, captureSessionId } from "../../open-sse/utils/sessionManager.js";

const rows = new Map();
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    get: async (key) => rows.get(key) ?? null,
    set: async (key, value) => { rows.set(key, value); },
    remove: async (key) => { rows.delete(key); },
    getAll: async () => Object.fromEntries(rows),
  }),
}));

let store;

const MODEL = "gemini-3.8-flash";
const partsFor = (label) => [{ thoughtSignature: `sig-${label}`, toolCall: { id: "call_1", toolType: "GOOGLE_SEARCH_WEB", args: { queries: [label] } } }];

beforeEach(async () => {
  rows.clear();
  vi.resetModules();
  store = await import("../../open-sse/services/thoughtSignatureStore.js");
});

describe("server-side tool parts are bound to session and scope", () => {
  it("returns the stored parts verbatim for the same session, scope and id", () => {
    store.storeGeminiServerParts("call_1", partsFor("A"), "session-a", MODEL, "scope-1");
    expect(store.getGeminiServerPartsSync("call_1", "session-a", MODEL, "scope-1")).toEqual(partsFor("A"));
  });

  it("does not leak across sessions or scopes for the same call id", () => {
    store.storeGeminiServerParts("call_1", partsFor("A"), "session-a", MODEL, "scope-1");
    expect(store.getGeminiServerPartsSync("call_1", "session-b", MODEL, "scope-1")).toBeNull();
    expect(store.getGeminiServerPartsSync("call_1", "session-a", MODEL, "scope-2")).toBeNull();
    expect(store.getGeminiServerPartsSync("call_1", null, MODEL, "scope-1")).toBeNull();
  });

  it("keeps two scopes with the same id apart", () => {
    store.storeGeminiServerParts("call_1", partsFor("one"), "session-a", MODEL, "scope-1");
    store.storeGeminiServerParts("call_1", partsFor("two"), "session-a", MODEL, "scope-2");
    expect(store.getGeminiServerPartsSync("call_1", "session-a", MODEL, "scope-1")).toEqual(partsFor("one"));
    expect(store.getGeminiServerPartsSync("call_1", "session-a", MODEL, "scope-2")).toEqual(partsFor("two"));
  });

  it.each([
    ["missing session", [undefined, "scope-1"]],
    ["empty session", ["", "scope-1"]],
    ["numeric session", [7, "scope-1"]],
    ["missing scope", ["session-a", undefined]],
    ["empty scope", ["session-a", ""]],
    ["numeric scope", ["session-a", 7]],
  ])("neither caches nor falls back with a %s", (_label, [sessionId, scope]) => {
    store.storeGeminiServerParts("call_1", partsFor("A"), sessionId, MODEL, scope);
    expect(rows.size).toBe(0);
    store.storeGeminiServerParts("call_1", partsFor("B"), "session-a", MODEL, "scope-1");
    expect(store.getGeminiServerPartsSync("call_1", sessionId, MODEL, scope)).toBeNull();
  });

  it("cannot collide through colon delimiters", () => {
    store.storeGeminiServerParts("c:d", partsFor("first"), "a", MODEL, "b");
    store.storeGeminiServerParts("d", partsFor("second"), "a:c", MODEL, "b");
    expect(store.getGeminiServerPartsSync("c:d", "a", MODEL, "b")).toEqual(partsFor("first"));
    expect(store.getGeminiServerPartsSync("d", "a:c", MODEL, "b")).toEqual(partsFor("second"));
    expect(store.getGeminiServerPartsSync("d", "a", MODEL, "c:b")).toBeNull();
  });

  it("ignores a legacy unscoped entry written through the opaque store", () => {
    store.storeGeminiThoughtSignature("serverparts:call_1", JSON.stringify(partsFor("legacy")), "session-a", MODEL);
    store.storeGeminiThoughtSignature("serverparts:call_1", JSON.stringify(partsFor("legacy")), null, MODEL);
    expect(store.getGeminiServerPartsSync("call_1", "session-a", MODEL, "scope-1")).toBeNull();
    expect(store.getGeminiServerPartsSync("call_1", "session-b", MODEL, "scope-1")).toBeNull();
  });

  it("isolates turn-anchored parts with identical reasoning, content and scope", () => {
    const turn = { reasoning: "thinking", content: "answer", scope: "scope-1" };
    store.storeGeminiServerPartsForTurn({ ...turn, sessionId: "session-a" }, partsFor("A"), MODEL);
    expect(store.findGeminiServerPartsForTurn({ ...turn, sessionId: "session-a" }, MODEL)).toEqual(partsFor("A"));
    expect(store.findGeminiServerPartsForTurn({ ...turn, sessionId: "session-b" }, MODEL)).toBeNull();
    expect(store.findGeminiServerPartsForTurn({ ...turn, sessionId: null }, MODEL)).toBeNull();
    expect(store.findGeminiServerPartsForTurn({ ...turn, scope: "scope-2", sessionId: "session-a" }, MODEL)).toBeNull();
  });

  it("leaves the opaque thought-signature cache compatible", () => {
    store.storeGeminiThoughtSignature("call_x", "opaque-sig", "session-a", MODEL);
    expect(store.getGeminiThoughtSignatureSync("call_x", "session-a", MODEL)).toBe("opaque-sig");
    expect(store.getGeminiThoughtSignatureSync("call_x", null, MODEL)).toBe("opaque-sig");
  });
});

describe("captureConversationId", () => {
  const capture = (rawHeaders, body = {}) => captureConversationId(body, { rawHeaders });

  it.each([
    ["no headers or body", {}, {}],
    ["a plain metadata.user_id", {}, { metadata: { user_id: "user-123" } }],
    ["a shared prompt_cache_key", {}, { prompt_cache_key: "shared-cache-key" }],
    ["a client request id", { "x-client-request-id": "req-1" }, {}],
    ["a workspace or account value", { "x-workspace-id": "ws-1", "x-account-id": "acct-1" }, { workspace_id: "ws-1" }],
  ])("is never genuine for %s", (_label, headers, body) => {
    expect(capture(headers, body)).toBeNull();
  });

  it("takes declared body and header identities", () => {
    expect(capture({}, { session_id: "body-session" })).toBe("body-session");
    expect(capture({}, { conversation_id: "conv-1", session_id: "body-session" })).toBe("conv-1");
    expect(capture({ "session-id": "session-1" })).toBe("session-1");
    expect(capture({ "x-session-id": "x-1", "session-id": "session-1" })).toBe("x-1");
    expect(capture({ "x-amp-thread-id": "amp-1" })).toBe("amp-1");
  });

  it("prefers the Codex thread-id over the session-id and is stable across calls", () => {
    const headers = { "session-id": "session-1", "thread-id": "thread-1" };
    expect(capture(headers)).toBe("thread-1");
    expect(capture(headers, { prompt_cache_key: "ignored" })).toBe("thread-1");
    expect(capture({ "thread-id": "thread-1" })).toBe("thread-1");
  });

  it("recognizes Claude Code sessions", () => {
    expect(capture({}, { metadata: { user_id: "user_abc_account__session_0123abcd-ef01" } })).toBe("claude:0123abcd-ef01");
    expect(capture({ "x-claude-code-session-id": "cc-1" })).toBe("claude:cc-1");
  });

  it("does not change the provider transport session", () => {
    const transport = captureSessionId({}, { rawHeaders: {} }, "selected-provider-credential");
    expect(typeof transport).toBe("string");
    expect(transport.length).toBeGreaterThan(0);
    expect(capture({})).toBeNull();
    expect(captureSessionId({}, { rawHeaders: {} }, "selected-provider-credential")).toBe(transport);
  });
});
