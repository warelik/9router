import { describe, it, expect, vi } from "vitest";

// Keep the signature store in RAM only; the SQLite kv layer is not under test here.
vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    get: async () => null,
    set: async () => {},
    remove: async () => {},
    getAll: async () => ({}),
  }),
}));

const { geminiToOpenAIResponse } = await import("../../open-sse/translator/response/gemini-to-openai.js");
const { openaiToGeminiRequest, openaiToGeminiCLIRequest, openaiToAntigravityRequest } = await import("../../open-sse/translator/request/openai-to-gemini.js");
const { DEFAULT_THINKING_AG_SIGNATURE } = await import("../../open-sse/config/defaultThinkingSignature.js");

// A model id is just a string here; only its family ("gemini") matters to the signature store.
const MODEL = "gemini-turn-signature-test";

const chunk = (parts, finishReason) => ({
  responseId: "r1",
  candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }],
});

// Translate the request that starts a turn, then stream the provider's answer to it, exactly as
// the router does: the request translator leaves the history identity on `credentials`.
function turn(history, chunks, sessionId = "authenticated-fixture-conversation") {
  const credentials = { _geminiServerPartsSessionId: sessionId };
  openaiToGeminiRequest(MODEL, { messages: history }, true, credentials);
  const state = { model: MODEL, turnScope: credentials._geminiTurnScope, serverPartsSessionId: sessionId };
  const out = [];
  for (const c of chunks) out.push(...(geminiToOpenAIResponse(c, state) || []));
  const delta = (k) => out.map((o) => o.choices?.[0]?.delta?.[k]).filter(Boolean).join("");
  return { reasoning: delta("reasoning_content"), content: delta("content") };
}

function modelParts(body, sessionId = "authenticated-fixture-conversation") {
  const req = openaiToGeminiRequest(MODEL, body, false, { _geminiServerPartsSessionId: sessionId });
  return req.contents.filter((c) => c.role === "model").flatMap((c) => c.parts);
}

const ask = (text) => ({ role: "user", content: text });

describe("signature of a tool-free thinking turn survives the round trip", () => {
  it("separates identical turns across trusted tenants/conversations and refuses an unscoped lookup", () => {
    const history = [ask("identical request")];
    turn(history, [chunk([{ text: "identical answer", thoughtSignature: "tenant-one-signature" }], "STOP")], "tenant-one/conversation");
    turn(history, [chunk([{ text: "identical answer", thoughtSignature: "tenant-two-signature" }], "STOP")], "tenant-two/conversation");
    const body = { messages: [...history, { role: "assistant", content: "identical answer" }, ask("next")] };
    expect(modelParts(body, "tenant-one/conversation")).toContainEqual({ text: "identical answer", thoughtSignature: "tenant-one-signature" });
    expect(modelParts(body, "tenant-two/conversation")).toContainEqual({ text: "identical answer", thoughtSignature: "tenant-two-signature" });
    expect(JSON.stringify(modelParts(body, null))).not.toContain("tenant-one-signature");
    expect(JSON.stringify(modelParts(body, null))).not.toContain("tenant-two-signature");
  });

  it("replays the provider's signature (on the answer part) when the client echoes reasoning + answer", () => {
    const sig = "real-signature-1";
    const { reasoning, content } = turn([ask("q1")], [
      chunk([{ thought: true, text: "unique thought one " }]),
      chunk([{ text: "unique answer one", thoughtSignature: sig }], "STOP"),
    ]);
    const parts = modelParts({
      messages: [ask("q1"), { role: "assistant", reasoning_content: reasoning, content }, ask("again")],
    });
    expect(parts).toContainEqual({ text: "unique answer one", thoughtSignature: sig });
    expect(parts.some((p) => p.thoughtSignature === DEFAULT_THINKING_AG_SIGNATURE)).toBe(false);
  });

  it("finds the signature from the answer alone when the client drops the reasoning", () => {
    const sig = "real-signature-2";
    const { content } = turn([ask("q2")], [
      chunk([{ thought: true, text: "unique thought two" }, { text: "unique answer two", thoughtSignature: sig }], "STOP"),
    ]);
    const parts = modelParts({
      messages: [ask("q2"), { role: "assistant", content }, ask("again")],
    });
    expect(parts).toContainEqual({ text: "unique answer two", thoughtSignature: sig });
  });

  it("keeps the default signature for reasoning this router never produced", () => {
    const parts = modelParts({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", reasoning_content: "foreign thought", content: "foreign answer" },
        { role: "user", content: "again" },
      ],
    });
    expect(parts).toContainEqual({ thought: true, text: "foreign thought" });
    expect(parts).toContainEqual({ thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE, text: "" });
    expect(parts).toContainEqual({ text: "foreign answer" });
  });

  it("does not store a signature that belongs to a tool call as a turn signature", () => {
    turn([ask("q4")], [
      chunk([{ thought: true, text: "tool thought" }, { functionCall: { name: "f", args: {} }, thoughtSignature: "tool-sig" }], "STOP"),
    ]);
    const parts = modelParts({
      messages: [ask("q4"), { role: "assistant", reasoning_content: "tool thought", content: "" }, ask("again")],
    });
    expect(parts.some((p) => p.thoughtSignature === "tool-sig")).toBe(false);
  });

  it("never replays a signature across conversations that give the same answer", () => {
    // Same visible answer, different histories and different hidden state.
    turn([ask("conversation A")], [chunk([{ text: "same short answer", thoughtSignature: "sig-A" }], "STOP")]);
    turn([ask("conversation B")], [chunk([{ text: "same short answer", thoughtSignature: "sig-B" }], "STOP")]);
    const replay = (q) => modelParts({
      messages: [ask(q), { role: "assistant", content: "same short answer" }, ask("again")],
    });
    expect(replay("conversation A")).toContainEqual({ text: "same short answer", thoughtSignature: "sig-A" });
    expect(replay("conversation B")).toContainEqual({ text: "same short answer", thoughtSignature: "sig-B" });
    expect(replay("conversation C")).toEqual([{ text: "same short answer" }]);
  });

  it("keeps working after the history grows by earlier tool-free turns", () => {
    const first = turn([ask("g1")], [chunk([{ text: "first answer g", thoughtSignature: "sig-g1" }], "STOP")]);
    const history = [ask("g1"), { role: "assistant", content: first.content }, ask("g2")];
    const second = turn(history, [chunk([{ text: "second answer g", thoughtSignature: "sig-g2" }], "STOP")]);
    const parts = modelParts({
      messages: [...history, { role: "assistant", content: second.content }, ask("g3")],
    });
    expect(parts).toContainEqual({ text: "first answer g", thoughtSignature: "sig-g1" });
    expect(parts).toContainEqual({ text: "second answer g", thoughtSignature: "sig-g2" });
  });

  it("separates conversations that differ only by system prompt", () => {
    const sys = (t) => ({ role: "system", content: t });
    turn([sys("rules one"), ask("s1")], [chunk([{ text: "shared reply s", thoughtSignature: "sig-sys1" }], "STOP")]);
    turn([sys("rules two"), ask("s1")], [chunk([{ text: "shared reply s", thoughtSignature: "sig-sys2" }], "STOP")]);
    const replay = (t) => modelParts({
      messages: [sys(t), ask("s1"), { role: "assistant", content: "shared reply s" }, ask("again")],
    });
    expect(replay("rules one")).toContainEqual({ text: "shared reply s", thoughtSignature: "sig-sys1" });
    expect(replay("rules two")).toContainEqual({ text: "shared reply s", thoughtSignature: "sig-sys2" });
    expect(replay("rules three")).toEqual([{ text: "shared reply s" }]);
  });

  it("separates conversations that differ only by tool arguments or tool results", () => {
    const call = (args) => ({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: JSON.stringify(args) } }] });
    const result = (text) => ({ role: "tool", tool_call_id: "c1", content: text });
    const history = (args, res) => [ask("t1"), call(args), result(res)];
    turn(history({ k: 1 }, "result one"), [chunk([{ text: "shared reply t", thoughtSignature: "sig-t1" }], "STOP")]);
    turn(history({ k: 2 }, "result two"), [chunk([{ text: "shared reply t", thoughtSignature: "sig-t2" }], "STOP")]);
    const replay = (args, res) => modelParts({
      messages: [...history(args, res), { role: "assistant", content: "shared reply t" }, ask("again")],
    }).filter((p) => p.text === "shared reply t");
    expect(replay({ k: 1 }, "result one")).toEqual([{ text: "shared reply t", thoughtSignature: "sig-t1" }]);
    expect(replay({ k: 2 }, "result two")).toEqual([{ text: "shared reply t", thoughtSignature: "sig-t2" }]);
    expect(replay({ k: 1 }, "result two")).toEqual([{ text: "shared reply t" }]);
  });

  it("separates otherwise identical tool exchanges that carry different call ids", () => {
    const history = (id) => [
      ask("ids"),
      { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: id, content: "same result" },
    ];
    turn(history("call-A"), [chunk([{ text: "shared reply i", thoughtSignature: "sig-idA" }], "STOP")]);
    turn(history("call-B"), [chunk([{ text: "shared reply i", thoughtSignature: "sig-idB" }], "STOP")]);
    const replay = (id) => modelParts({
      messages: [...history(id), { role: "assistant", content: "shared reply i" }, ask("again")],
    }).filter((p) => p.text === "shared reply i");
    expect(replay("call-A")).toEqual([{ text: "shared reply i", thoughtSignature: "sig-idA" }]);
    expect(replay("call-B")).toEqual([{ text: "shared reply i", thoughtSignature: "sig-idB" }]);
  });

  it("leaves the history identity on credentials for the Gemini CLI and Antigravity wrappers too", () => {
    const body = { messages: [ask("wrapped")] };
    const cli = {};
    openaiToGeminiCLIRequest(MODEL, body, true, cli);
    const ag = {};
    openaiToAntigravityRequest(MODEL, body, true, ag);
    const plain = {};
    openaiToGeminiRequest(MODEL, body, true, plain);
    expect(plain._geminiTurnScope).toMatch(/^[0-9a-f]{64}$/);
    expect(cli._geminiTurnScope).toBe(plain._geminiTurnScope);
    expect(ag._geminiTurnScope).toBe(plain._geminiTurnScope);
  });
});
