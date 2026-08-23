import assert from "node:assert/strict";
import {
  deriveContinuityScopeId,
  canonicalizeIncomingHistory,
  canonicalizeClientOutput,
  analyzeContinuityHistory,
  buildCompletedPairs,
  buildPairWindow,
  splitCompletedPairs,
  stableJson,
  normalizeText,
  createClientOutputAccumulator,
  normalizeToolLinkage
} from "./continuityCanonicalizer.js";
import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { stripTaggedThinking } from "./taggedThinkingNormalizer.js";
import { clearContinuityStateForTests, commitContinuityFromClientOutput, commitContinuityState, resolveContinuityState } from "./continuityStore.js";

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check("stableJson: serializes structures deterministically", () => {
  const o1 = { b: 2, a: 1, c: { e: 5, d: 4 } };
  const o2 = { a: 1, c: { d: 4, e: 5 }, b: 2 };
  assert.equal(stableJson(o1), stableJson(o2));
  assert.equal(stableJson([1, 2, { b: 1, a: 2 }]), "[1,2,{\"a\":2,\"b\":1}]");
});

check("normalizeText: CR/CRLF -> LF", () => {
  assert.equal(normalizeText("hello\r\nworld\r"), "hello\nworld\n");
  assert.equal(normalizeText("no changes"), "no changes");
});

check("deriveContinuityScopeId: computes stable scope hex from apiKey", () => {
  const scope1 = deriveContinuityScopeId("key-1");
  const scope2 = deriveContinuityScopeId("key-1");
  const scope3 = deriveContinuityScopeId("key-2");

  assert.ok(typeof scope1 === "string" && scope1.length === 64);
  assert.equal(scope1, scope2);
  assert.notEqual(scope1, scope3);
  assert.equal(deriveContinuityScopeId(null), null);
  assert.equal(deriveContinuityScopeId(""), null);
});

check("canonicalizeIncomingHistory: OpenAI user-assistant text flow", () => {
  const body = {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "openai");
  assert.equal(events.length, 2);
  assert.equal(events[0].role, "user");
  assert.equal(events[0].kind, "text");
  assert.equal(events[0].payload, "hello");
  assert.equal(events[1].role, "assistant");
  assert.equal(events[1].kind, "text");
  assert.equal(events[1].payload, "hi there");
});

check("canonicalizeIncomingHistory: OpenAI tool call + tool result linkage", () => {
  const body = {
    messages: [
      { role: "user", content: "call tool" },
      {
        role: "assistant",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "my_tool", arguments: "{\"arg1\": 10}" }
        }]
      },
      { role: "tool", tool_call_id: "call-1", content: "success" }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "openai");
  assert.equal(events.length, 3);
  assert.equal(events[0].role, "user");
  assert.equal(events[1].role, "assistant");
  assert.equal(events[1].kind, "tool_call");
  assert.equal(events[1].payload.name, "my_tool");
  assert.equal(events[1].payload.arguments, "{\"arg1\":10}");
  assert.equal(events[1].payload.rawLink, "call-1");
  assert.equal(events[2].role, "tool");
  assert.equal(events[2].kind, "tool_result");
  assert.equal(events[2].payload.rawLink, "call-1");
  assert.equal(events[2].payload.content, "success");
});

check("canonicalizeIncomingHistory: Responses API shape mapping (call_id linkage)", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", name: "tool", arguments: { a: 1 }, call_id: "call-1" },
      { type: "function_call_output", call_id: "call-1", output: "done" }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "openai-responses");
  assert.equal(events.length, 3);
  assert.equal(events[0].role, "user");
  assert.equal(events[1].role, "assistant");
  assert.equal(events[1].kind, "tool_call");
  assert.equal(events[1].payload.arguments, "{\"a\":1}");
  assert.equal(events[1].payload.rawLink, "call-1");
  assert.equal(events[2].payload.rawLink, "call-1");
  assert.equal(events[2].role, "tool");
  assert.equal(events[2].kind, "tool_result");
});

check("canonicalizeIncomingHistory: Claude content blocks and Gemini parts mapping", () => {
  const claudeBody = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking text" },
          { type: "tool_use", id: "tu-1", name: "t1", input: { arg: "val" } }
        ]
      }
    ]
  };
  const claudeEvents = canonicalizeIncomingHistory(claudeBody, "claude");
  assert.equal(claudeEvents.length, 2);
  assert.equal(claudeEvents[0].role, "assistant");
  assert.equal(claudeEvents[0].kind, "text");
  assert.equal(claudeEvents[1].role, "assistant");
  assert.equal(claudeEvents[1].kind, "tool_call");
  assert.equal(claudeEvents[1].payload.rawLink, "tu-1");

  const geminiBody = {
    contents: [
      {
        role: "model",
        parts: [
          { text: "model response text" },
          { functionCall: { name: "gtool", args: { x: 1 } } }
        ]
      }
    ]
  };
  const geminiEvents = canonicalizeIncomingHistory(geminiBody, "antigravity");
  assert.equal(geminiEvents.length, 2);
  assert.equal(geminiEvents[0].role, "assistant");
  assert.equal(geminiEvents[0].kind, "text");
  assert.equal(geminiEvents[0].payload, "model response text");
  assert.equal(geminiEvents[1].role, "assistant");
  assert.equal(geminiEvents[1].kind, "tool_call");
  assert.equal(geminiEvents[1].payload.name, "gtool");

  const wrappedAntigravity = {
    userAgent: "antigravity",
    request: {
      systemInstruction: { parts: [{ text: "system ctx" }] },
      contents: [
        { role: "user", parts: [{ text: "A1" }] },
        { role: "model", parts: [{ text: "O1" }] },
        { role: "user", parts: [{ text: "A2" }] }
      ]
    }
  };
  const wrappedEvents = canonicalizeIncomingHistory(wrappedAntigravity, "antigravity");
  assert.deepEqual(wrappedEvents.map(e => [e.role, e.kind, e.payload]), [
    ["system", "text", "system ctx"],
    ["user", "text", "A1"],
    ["assistant", "text", "O1"],
    ["user", "text", "A2"]
  ]);
  assert.equal(buildCompletedPairs(wrappedEvents, "test-scope").length, 1);
});

check("canonicalizeIncomingHistory: Claude tool_result inline inside role:user content array", () => {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "search", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "found it" }] }
    ]
  };
  const events = canonicalizeIncomingHistory(body, "claude");
  assert.equal(events.length, 2);
  assert.equal(events[1].role, "tool");
  assert.equal(events[1].kind, "tool_result");
  assert.equal(events[1].payload.rawLink, "tu-1");
  assert.equal(events[1].payload.content, "found it");
});

check("canonicalizeIncomingHistory: assistant turn with no text/tool_call anchors an empty_output event", () => {
  const body = { messages: [{ role: "assistant", content: "" }] };
  const events = canonicalizeIncomingHistory(body, "openai");
  assert.equal(events.length, 1);
  assert.equal(events[0].role, "assistant");
  assert.equal(events[0].kind, "empty_output");
});

check("canonicalizeClientOutput: reasoning-only response (no text/tool_calls) anchors an empty_output event", () => {
  const openaiThinkingOnly = { choices: [{ message: { content: "", reasoning_content: "all budget spent thinking" } }] };
  const events = canonicalizeClientOutput(openaiThinkingOnly, "openai");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "empty_output");
});

check("canonicalizeClientOutput: Gemini/Antigravity wrapped candidates and Ollama message shape", () => {
  const geminiOut = {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text: "gemini answer" }, { functionCall: { name: "gt", args: { x: 1 }, id: "c1" } }] } }]
    }
  };
  const geminiEvents = canonicalizeClientOutput(geminiOut, "antigravity");
  assert.equal(geminiEvents.length, 2);
  assert.equal(geminiEvents[0].kind, "text");
  assert.equal(geminiEvents[0].payload, "gemini answer");
  assert.equal(geminiEvents[1].kind, "tool_call");
  assert.equal(geminiEvents[1].payload.name, "gt");

  const ollamaOut = { message: { role: "assistant", content: "ollama answer" } };
  const ollamaEvents = canonicalizeClientOutput(ollamaOut, "ollama");
  assert.equal(ollamaEvents.length, 1);
  assert.equal(ollamaEvents[0].kind, "text");
  assert.equal(ollamaEvents[0].payload, "ollama answer");
});

check("createClientOutputAccumulator: assembles streaming deltas into canonical events", () => {
  // OpenAI-shape: text delta + accumulated tool_calls delta
  const openaiAcc = createClientOutputAccumulator();
  openaiAcc.push({ choices: [{ delta: { content: "Hel" } }] });
  openaiAcc.push({ choices: [{ delta: { content: "lo" } }] });
  openaiAcc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "my_", arguments: "" } }] } }] });
  openaiAcc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "tool", arguments: "{\"a\":" } }] } }] });
  openaiAcc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] });
  const openaiEvents = openaiAcc.finalize();
  assert.equal(openaiEvents.length, 2);
  assert.equal(openaiEvents[0].kind, "text");
  assert.equal(openaiEvents[0].payload, "Hello");
  assert.equal(openaiEvents[1].kind, "tool_call");
  assert.equal(openaiEvents[1].payload.name, "my_tool");
  assert.equal(openaiEvents[1].payload.rawLink, "call_1");
  assert.equal(openaiEvents[1].payload.arguments, "{\"a\":1}");

  // Claude-shape: content_block_start (tool_use) + input_json_delta accumulation
  const claudeAcc = createClientOutputAccumulator();
  claudeAcc.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  claudeAcc.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } });
  claudeAcc.push({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "search" } });
  claudeAcc.push({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } });
  const claudeEvents = claudeAcc.finalize();
  assert.equal(claudeEvents.length, 2);
  assert.equal(claudeEvents[0].payload, "hi");
  assert.equal(claudeEvents[1].payload.name, "search");
  assert.equal(claudeEvents[1].payload.rawLink, "tu_1");
  assert.equal(claudeEvents[1].payload.arguments, "{\"q\":\"x\"}");
});

check("createClientOutputAccumulator: preserves real interleaving order (text, tool_call, text), not text-then-tool_calls", () => {
  // Claude-shape: text block, then tool_use block, then a second distinct text block —
  // finalize() must emit them in that exact order, not merge both text runs into one
  // event ahead of the tool call.
  const acc = createClientOutputAccumulator();
  acc.push({ type: "content_block_start", index: 0, content_block: { type: "text" } });
  acc.push({ type: "content_block_delta", index: 0, delta: { text: "before" } });
  acc.push({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_2", name: "lookup" } });
  acc.push({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } });
  acc.push({ type: "content_block_start", index: 2, content_block: { type: "text" } });
  acc.push({ type: "content_block_delta", index: 2, delta: { text: "after" } });
  const events = acc.finalize();
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, "text");
  assert.equal(events[0].payload, "before");
  assert.equal(events[1].kind, "tool_call");
  assert.equal(events[1].payload.name, "lookup");
  assert.equal(events[2].kind, "text");
  assert.equal(events[2].payload, "after");
});

check("createClientOutputAccumulator: reasoning-only stream (no text/tool_call push) still anchors an empty_output event", () => {
  const acc = createClientOutputAccumulator();
  acc.push({ choices: [{ delta: { reasoning_content: "just thinking" } }] });
  const events = acc.finalize();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "empty_output");
});

check("canonicalizeIncomingHistory: Responses string input and typed input_text/output_text blocks", () => {
  const stringInput = canonicalizeIncomingHistory({ input: "plain question" }, "openai-responses");
  assert.equal(stringInput.length, 1);
  assert.equal(stringInput[0].role, "user");
  assert.equal(stringInput[0].kind, "text");
  assert.equal(stringInput[0].payload, "plain question");

  const typedBlocks = canonicalizeIncomingHistory({
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }
    ]
  }, "openai-responses");
  assert.equal(typedBlocks.length, 2);
  assert.equal(typedBlocks[0].payload, "hi");
  assert.equal(typedBlocks[1].role, "assistant");
  assert.equal(typedBlocks[1].payload, "hello");
});

check("round-trip symmetry: Responses output function_call fingerprints identically to replayed input (call_id linkage)", () => {
  const outEvents = canonicalizeClientOutput({
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", id: "fc_item_9", call_id: "call-7", name: "lookup", arguments: "{\"q\":1}" }
    ]
  }, "openai-responses");
  const inEvents = canonicalizeIncomingHistory({
    input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", id: "fc_item_OTHER", call_id: "call-7", name: "lookup", arguments: "{\"q\":1}" }
    ]
  }, "openai-responses");
  assert.deepEqual(outEvents, inEvents);
  assert.equal(outEvents[1].payload.rawLink, "call-7");
});

check("round-trip symmetry: Gemini interleaved output (text, functionCall, text) matches replayed contents[] order", () => {
  const parts = [
    { text: "before " },
    { text: "call" },
    { functionCall: { name: "gt", args: { x: 1 }, id: "c1" } },
    { text: "after" }
  ];
  const outEvents = canonicalizeClientOutput({ candidates: [{ content: { role: "model", parts } }] }, "gemini");
  const inEvents = canonicalizeIncomingHistory({ contents: [{ role: "model", parts }] }, "gemini");
  assert.deepEqual(outEvents, inEvents);
  assert.equal(outEvents.length, 3);
  assert.equal(outEvents[0].payload, "before call");
  assert.equal(outEvents[1].kind, "tool_call");
  assert.equal(outEvents[2].payload, "after");
});

check("canonicalizeClientOutput + accumulator: Ollama message.tool_calls become tool_call events", () => {
  const out = {
    message: {
      role: "assistant",
      content: "using tool",
      tool_calls: [{ function: { name: "otool", arguments: { a: 1 } } }]
    }
  };
  const events = canonicalizeClientOutput(out, "ollama");
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "text");
  assert.equal(events[1].kind, "tool_call");
  assert.equal(events[1].payload.name, "otool");
  assert.equal(events[1].payload.arguments, "{\"a\":1}");

  const acc = createClientOutputAccumulator();
  acc.push({ message: { content: "using tool" } });
  acc.push({ message: { content: "", tool_calls: [{ function: { name: "otool", arguments: { a: 1 } } }] } });
  assert.deepEqual(acc.finalize(), events);
});

check("round-trip symmetry: Gemini thought-only model turn replays as empty_output pair", () => {
  const scopeId = "test-scope";
  const userTurn = { role: "user", parts: [{ text: "A1" }] };
  const thoughtOnlyModelTurn = { role: "model", parts: [{ thought: true, text: "hidden reasoning" }] };

  const committedPairs = buildCompletedPairs([
    ...canonicalizeIncomingHistory({ contents: [userTurn] }, "gemini"),
    ...canonicalizeClientOutput({ candidates: [{ content: thoughtOnlyModelTurn }] }, "gemini")
  ], scopeId);
  const replayedPairs = buildCompletedPairs(
    canonicalizeIncomingHistory({ contents: [userTurn, thoughtOnlyModelTurn] }, "gemini"),
    scopeId
  );

  assert.equal(committedPairs.length, 1);
  assert.deepEqual(replayedPairs, committedPairs);
});

check("round-trip symmetry: Claude text→tool_use→text content blocks preserve pair hash", () => {
  const scopeId = "test-scope";
  const content = [
    { type: "text", text: "before" },
    { type: "tool_use", id: "tu_2", name: "lookup", input: {} },
    { type: "text", text: "after" }
  ];
  const outEvents = canonicalizeClientOutput({ content }, "claude");
  const replayEvents = canonicalizeIncomingHistory({
    messages: [
      { role: "user", content: "A1" },
      { role: "assistant", content }
    ]
  }, "claude");

  assert.deepEqual(outEvents, replayEvents.slice(1));
  assert.deepEqual(
    buildCompletedPairs([{ role: "user", kind: "text", payload: "A1" }, ...outEvents], scopeId),
    buildCompletedPairs(replayEvents, scopeId)
  );
});

check("round-trip symmetry: assistant attachments are output events and pair anchors", () => {
  const scopeId = "test-scope";
  const userEvent = { role: "user", kind: "text", payload: "A1" };
  const cases = [
    {
      out: { choices: [{ message: { content: [{ type: "text", text: "before" }, { type: "image_url", image_url: { url: "https://example.test/a.png" } }, { type: "text", text: "after" }] } }] },
      replay: { messages: [{ role: "user", content: "A1" }, { role: "assistant", content: [{ type: "text", text: "before" }, { type: "image_url", image_url: { url: "https://example.test/a.png" } }, { type: "text", text: "after" }] }] },
      format: "openai"
    },
    {
      out: { content: [{ type: "text", text: "before" }, { type: "image", mime_type: "image/png", url: "cid:claude-img" }, { type: "text", text: "after" }] },
      replay: { messages: [{ role: "user", content: "A1" }, { role: "assistant", content: [{ type: "text", text: "before" }, { type: "image", mime_type: "image/png", url: "cid:claude-img" }, { type: "text", text: "after" }] }] },
      format: "claude"
    },
    {
      out: { candidates: [{ content: { role: "model", parts: [{ text: "before" }, { inlineData: { mime_type: "image/png", url: "cid:gemini-img" } }, { text: "after" }] } }] },
      replay: { contents: [{ role: "user", parts: [{ text: "A1" }] }, { role: "model", parts: [{ text: "before" }, { inlineData: { mime_type: "image/png", url: "cid:gemini-img" } }, { text: "after" }] }] },
      format: "gemini"
    }
  ];

  for (const { out, replay, format } of cases) {
    const outEvents = canonicalizeClientOutput(out, format);
    const replayEvents = canonicalizeIncomingHistory(replay, format);
    assert.ok(outEvents.some(e => e.kind === "attachment"));
    assert.deepEqual(buildCompletedPairs([userEvent, ...outEvents], scopeId), buildCompletedPairs(replayEvents, scopeId));
  }
});

check("canonicalizeAttachment: inline/base64 attachments use content digests, not empty descriptors", () => {
  const geminiA = canonicalizeIncomingHistory({ contents: [{ role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "base64-image-A" } }] }] }, "gemini");
  const geminiB = canonicalizeIncomingHistory({ contents: [{ role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "base64-image-B" } }] }] }, "gemini");
  assert.equal(geminiA.length, 1);
  assert.equal(geminiA[0].kind, "attachment");
  assert.notEqual(geminiA[0].payload, geminiB[0].payload);
  const geminiDescriptor = JSON.parse(geminiA[0].payload);
  assert.equal(geminiDescriptor.mime, "image/png");
  assert.ok(geminiDescriptor.contentDigest);
  assert.equal(geminiDescriptor.reference, "");

  const claudeA = canonicalizeIncomingHistory({ messages: [{ role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "claude-image-A" } }] }] }, "claude");
  const claudeB = canonicalizeIncomingHistory({ messages: [{ role: "assistant", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "claude-image-B" } }] }] }, "claude");
  assert.equal(claudeA.length, 1);
  assert.equal(claudeA[0].kind, "attachment");
  assert.notEqual(claudeA[0].payload, claudeB[0].payload);
  const claudeDescriptor = JSON.parse(claudeA[0].payload);
  assert.equal(claudeDescriptor.mime, "image/png");
  assert.ok(claudeDescriptor.contentDigest);
});

check("round-trip symmetry: streamed assistant attachment events match replayed Gemini history", () => {
  const scopeId = "test-scope";
  const userTurn = { role: "user", parts: [{ text: "A1" }] };
  const modelTurn = {
    role: "model",
    parts: [
      { text: "готово" },
      { inlineData: { mimeType: "image/png", data: "stream-image" } }
    ]
  };
  const acc = createClientOutputAccumulator();
  acc.push({ candidates: [{ content: modelTurn }] });

  const committedPairs = buildCompletedPairs([
    ...canonicalizeIncomingHistory({ contents: [userTurn] }, "gemini"),
    ...acc.finalize()
  ], scopeId);
  const replayedPairs = buildCompletedPairs(
    canonicalizeIncomingHistory({ contents: [userTurn, modelTurn] }, "gemini"),
    scopeId
  );

  assert.equal(committedPairs.length, 1);
  assert.deepEqual(replayedPairs, committedPairs);
});

check("buildCompletedPairs & buildPairWindow: structures segments into immutable pair fingerprints", () => {
  const scopeId = "test-scope";
  const events = [
    { role: "user", kind: "text", payload: "hello" },
    { role: "assistant", kind: "text", payload: "hi" },
    { role: "user", kind: "text", payload: "how are you?" },
    { role: "assistant", kind: "text", payload: "doing well" }
  ];
  const pairs = buildCompletedPairs(events, scopeId);
  assert.equal(pairs.length, 2);

  const window = buildPairWindow(pairs, 1);
  assert.equal(window.length, 1);
  assert.equal(window[0], pairs[1]);
});

check("buildCompletedPairs: leading system/developer/instructions/systemInstruction is excluded from pair identity", () => {
  const scopeId = "test-scope";

  // Full history: S, A1->O1, A2->O2, A3 (A3 has no response yet, so it stays as
  // trailing input and isn't part of any completed pair).
  const fullOpenAI = {
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "A1" },
      { role: "assistant", content: "O1" },
      { role: "user", content: "A2" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  // The client truncated turn 1 (A1/O1) but keeps resending the same system prompt.
  const truncatedOpenAI = {
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "A2" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  const fullPairs = buildCompletedPairs(canonicalizeIncomingHistory(fullOpenAI, "openai"), scopeId);
  const truncatedPairs = buildCompletedPairs(canonicalizeIncomingHistory(truncatedOpenAI, "openai"), scopeId);
  assert.equal(fullPairs.length, 2);
  assert.equal(truncatedPairs.length, 1);
  assert.equal(fullPairs[fullPairs.length - 1], truncatedPairs[truncatedPairs.length - 1]);

  // A DIFFERENT system prompt over the same visible turn must still match — ambient
  // system/developer content is not part of dialog identity. Production tracing on a
  // live Antigravity dialog proved a client/proxy can rebuild systemInstruction between
  // requests inside the SAME dialog (same visible input, same visible output), which
  // broke continuity when this used to assert notEqual.
  const differentSystem = {
    messages: [
      { role: "system", content: "DIFFERENT" },
      { role: "user", content: "A2" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  const differentPairs = buildCompletedPairs(canonicalizeIncomingHistory(differentSystem, "openai"), scopeId);
  assert.equal(differentPairs[differentPairs.length - 1], fullPairs[fullPairs.length - 1]);

  // Sanity control: identity must still discriminate on the actual visible turn —
  // only the leading system/developer/instructions/systemInstruction content is exempt.
  const differentVisibleTurn = {
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "A2-DIFFERENT" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  const differentVisiblePairs = buildCompletedPairs(canonicalizeIncomingHistory(differentVisibleTurn, "openai"), scopeId);
  assert.notEqual(differentVisiblePairs[differentVisiblePairs.length - 1], fullPairs[fullPairs.length - 1]);

  // OpenAI `developer` role is equally persistent context.
  const fullDeveloper = {
    messages: [
      { role: "developer", content: "DEV" },
      { role: "user", content: "A1" },
      { role: "assistant", content: "O1" },
      { role: "user", content: "A2" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  const truncatedDeveloper = {
    messages: [
      { role: "developer", content: "DEV" },
      { role: "user", content: "A2" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  const fullDeveloperPairs = buildCompletedPairs(canonicalizeIncomingHistory(fullDeveloper, "openai"), scopeId);
  const truncatedDeveloperPairs = buildCompletedPairs(canonicalizeIncomingHistory(truncatedDeveloper, "openai"), scopeId);
  assert.equal(fullDeveloperPairs[fullDeveloperPairs.length - 1], truncatedDeveloperPairs[truncatedDeveloperPairs.length - 1]);

  // Claude's top-level `system` field.
  const claudeFull = {
    system: "CSYS",
    messages: [
      { role: "user", content: "A1" },
      { role: "assistant", content: "O1" },
      { role: "user", content: "A2" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  const claudeTrunc = {
    system: "CSYS",
    messages: [
      { role: "user", content: "A2" },
      { role: "assistant", content: "O2" },
      { role: "user", content: "A3" }
    ]
  };
  const claudeFullPairs = buildCompletedPairs(canonicalizeIncomingHistory(claudeFull, "claude"), scopeId);
  const claudeTruncPairs = buildCompletedPairs(canonicalizeIncomingHistory(claudeTrunc, "claude"), scopeId);
  assert.equal(claudeFullPairs[claudeFullPairs.length - 1], claudeTruncPairs[claudeTruncPairs.length - 1]);

  // OpenAI Responses API top-level `instructions` string.
  const respFull = {
    instructions: "RSYS",
    input: [
      { role: "user", content: "A1" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "O1" }] },
      { role: "user", content: "A2" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "O2" }] },
      { role: "user", content: "A3" }
    ]
  };
  const respTrunc = {
    instructions: "RSYS",
    input: [
      { role: "user", content: "A2" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "O2" }] },
      { role: "user", content: "A3" }
    ]
  };
  const respFullPairs = buildCompletedPairs(canonicalizeIncomingHistory(respFull, "openai-responses"), scopeId);
  const respTruncPairs = buildCompletedPairs(canonicalizeIncomingHistory(respTrunc, "openai-responses"), scopeId);
  assert.equal(respFullPairs[respFullPairs.length - 1], respTruncPairs[respTruncPairs.length - 1]);

  // Antigravity wrapped body.request.systemInstruction.
  const agFull = {
    userAgent: "antigravity",
    request: {
      systemInstruction: { parts: [{ text: "AGSYS" }] },
      contents: [
        { role: "user", parts: [{ text: "A1" }] },
        { role: "model", parts: [{ text: "O1" }] },
        { role: "user", parts: [{ text: "A2" }] },
        { role: "model", parts: [{ text: "O2" }] },
        { role: "user", parts: [{ text: "A3" }] }
      ]
    }
  };
  const agTrunc = {
    userAgent: "antigravity",
    request: {
      systemInstruction: { parts: [{ text: "AGSYS" }] },
      contents: [
        { role: "user", parts: [{ text: "A2" }] },
        { role: "model", parts: [{ text: "O2" }] },
        { role: "user", parts: [{ text: "A3" }] }
      ]
    }
  };
  const agFullPairs = buildCompletedPairs(canonicalizeIncomingHistory(agFull, "antigravity"), scopeId);
  const agTruncPairs = buildCompletedPairs(canonicalizeIncomingHistory(agTrunc, "antigravity"), scopeId);
  assert.equal(agFullPairs[agFullPairs.length - 1], agTruncPairs[agTruncPairs.length - 1]);

  // The exact production incident that motivated this contract change: Antigravity
  // rebuilt systemInstruction between requests inside the SAME dialog with no
  // truncation at all (identical full visible history both times, different
  // systemInstruction value) — pair-level trace logging showed the committed and
  // looked-up context digests diverging while input/output digests matched, so the
  // resolver reported reason=no-index on every subsequent turn.
  const agDynamicSystem = {
    userAgent: "antigravity",
    request: {
      systemInstruction: { parts: [{ text: "AGSYS-REBUILT-DIFFERENTLY" }] },
      contents: [
        { role: "user", parts: [{ text: "A1" }] },
        { role: "model", parts: [{ text: "O1" }] },
        { role: "user", parts: [{ text: "A2" }] },
        { role: "model", parts: [{ text: "O2" }] },
        { role: "user", parts: [{ text: "A3" }] }
      ]
    }
  };
  const agDynamicPairs = buildCompletedPairs(canonicalizeIncomingHistory(agDynamicSystem, "antigravity"), scopeId);
  assert.equal(agDynamicPairs[agDynamicPairs.length - 1], agFullPairs[agFullPairs.length - 1]);
});

check("round-trip symmetry: Claude thinking -> OpenAI -> Antigravity translated stream must be tag-stripped before commit, or fabricated <think>/</think> markers diverge the pair hash from client replay", () => {
  const chunks = [
    { type: "message_start", message: { id: "msg_1", model: "glm-4" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning text" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_1", name: "lookup" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" }
  ];

  // Mirrors stream.js translate-mode: targetFormat=claude (provider, e.g. GLM
  // speaking Claude-shaped SSE), sourceFormat=antigravity (client). translateResponse
  // pivots claude -> openai -> antigravity, and claudeToOpenAIResponse fabricates
  // <think>/</think> text markers around the OpenAI intermediate's reasoning_content —
  // markers that exist ONLY in this synthetic OpenAI hop, never in what the
  // Antigravity client itself will echo back on the next turn.
  const runChain = (applyFix) => {
    const state = { ...initState(FORMATS.ANTIGRAVITY), provider: "glm", toolNameMap: null, model: "glm-4" };
    const acc = createClientOutputAccumulator();
    for (const chunk of chunks) {
      const translated = translateResponse(FORMATS.CLAUDE, FORMATS.ANTIGRAVITY, chunk, state);
      if (!translated?.length) continue;
      for (const item of translated) {
        if (!item) continue;
        if (applyFix) stripTaggedThinking(item);
        acc.push(item);
      }
    }
    return acc.finalize();
  };

  const unstrippedEvents = runChain(false);
  const strippedEvents = runChain(true);

  // What the Antigravity client will actually replay next turn: thought part
  // (excluded from fingerprint by design) + plain text + the tool call — no tags.
  const replayedEvents = canonicalizeIncomingHistory({
    userAgent: "antigravity",
    request: {
      contents: [
        { role: "user", parts: [{ text: "question" }] },
        {
          role: "model", parts: [
            { thought: true, text: "reasoning text" },
            { text: "answer" },
            { functionCall: { name: "lookup", args: {} } }
          ]
        }
      ]
    }
  }, "antigravity").slice(1); // drop the leading user turn, keep only the assistant output events

  // Without the fix, the fabricated tags survive into the committed text event —
  // this must diverge from what the client replays.
  assert.notDeepEqual(unstrippedEvents, replayedEvents);
  assert.equal(unstrippedEvents[0].payload, "<think></think>answer");

  // With the fix (stripTaggedThinking applied to each translated item before
  // pushing into the continuity output accumulator, as stream.js now does),
  // the committed event stream must exactly match what the client replays.
  assert.deepEqual(strippedEvents, replayedEvents);
  assert.equal(strippedEvents[0].payload, "answer");
});

check("round-trip symmetry: Responses JSON passthrough is tag-stripped before commit", () => {
  const response = {
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "<think>hidden</think>visible" }]
    }]
  };
  stripTaggedThinking(response);
  const committed = canonicalizeClientOutput(response, "openai-responses");
  const replayed = canonicalizeIncomingHistory({
    input: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hiddenvisible" }]
    }]
  }, "openai-responses");
  assert.deepEqual(committed, replayed);
});

check("normalizeToolLinkage: emits semantic tool call/result descriptors without raw ids", () => {
  const events = [
    { role: "user", kind: "text", payload: "do both" },
    { role: "assistant", kind: "tool_call", payload: { name: "search", arguments: "{}", rawLink: "raw-A" } },
    { role: "assistant", kind: "tool_call", payload: { name: "fetch", arguments: "{\"n\":1}", rawLink: "raw-B" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "raw-B", content: "fetch-result" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "raw-A", content: "search-result" } },
    { role: "assistant", kind: "text", payload: "done" }
  ];
  const normalized = normalizeToolLinkage(events);
  assert.deepEqual(normalized[1].payload, { slot: "slot:0", name: "search", arguments: "{}" });
  assert.deepEqual(normalized[2].payload, { slot: "slot:1", name: "fetch", arguments: "{\"n\":1}" });
  // Results were sent reversed (fetch's result first) but must still resolve to the
  // call they actually answer, not their physical position in the array.
  assert.deepEqual(normalized[3].payload, { slot: "slot:1", name: "fetch", arguments: "{\"n\":1}", content: "fetch-result" });
  assert.deepEqual(normalized[4].payload, { slot: "slot:0", name: "search", arguments: "{}", content: "search-result" });
  assert.ok(!("id" in normalized[1].payload));
  assert.ok(!("rawLink" in normalized[3].payload));
  // Non tool_call/tool_result events pass through untouched (same reference).
  assert.equal(normalized[0], events[0]);
  assert.equal(normalized[5], events[5]);
  // Pure: does not mutate the input events.
  assert.equal(events[1].payload.rawLink, "raw-A");

  // An orphaned tool_result (no matching preceding call in view, e.g. the call was
  // truncated out of history) must not retain raw linkage or invent a fake slot.
  const orphanNormalized = normalizeToolLinkage([
    { role: "tool", kind: "tool_result", payload: { rawLink: "unknown-id", content: "x" } }
  ]);
  assert.deepEqual(orphanNormalized[0].payload, { unlinked: true, content: "x" });

  // A linked result consumes the pending descriptor. A duplicate/stale result
  // with the same raw link must become unlinked instead of reusing a closed call.
  const duplicateResult = normalizeToolLinkage([
    { role: "assistant", kind: "tool_call", payload: { name: "once", arguments: "{}", rawLink: "dup" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "dup", content: "first" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "dup", content: "second" } }
  ]);
  assert.deepEqual(duplicateResult[1].payload, { slot: "slot:0", name: "once", arguments: "{}", content: "first" });
  assert.deepEqual(duplicateResult[2].payload, { unlinked: true, content: "second" });

  // A name-hint match must consume the same descriptor and delete its original
  // raw-link mapping too. Otherwise a later stale raw-linked result can attach
  // to a call that was already answered by name.
  const nameHintConsumesRawLink = normalizeToolLinkage([
    { role: "assistant", kind: "tool_call", payload: { name: "lookup", arguments: "{}", rawLink: "raw-stale" } },
    { role: "tool", kind: "tool_result", payload: { nameHint: "lookup", content: "first" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "raw-stale", content: "second" } }
  ]);
  assert.deepEqual(nameHintConsumesRawLink[1].payload, { slot: "slot:0", name: "lookup", arguments: "{}", content: "first" });
  assert.deepEqual(nameHintConsumesRawLink[2].payload, { unlinked: true, content: "second" });

  // Duplicate tool names are ambiguous for name-only matching, but raw links
  // still preserve real out-of-order call/result association.
  const sameNameOutOfOrder = normalizeToolLinkage([
    { role: "assistant", kind: "tool_call", payload: { name: "lookup", arguments: "{\"n\":1}", rawLink: "call-1" } },
    { role: "assistant", kind: "tool_call", payload: { name: "lookup", arguments: "{\"n\":2}", rawLink: "call-2" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "call-2", content: "two" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "call-1", content: "one" } }
  ]);
  assert.deepEqual(sameNameOutOfOrder[2].payload, { slot: "slot:1", name: "lookup", arguments: "{\"n\":2}", content: "two" });
  assert.deepEqual(sameNameOutOfOrder[3].payload, { slot: "slot:0", name: "lookup", arguments: "{\"n\":1}", content: "one" });

  // Text interleaved between two calls in the same assistant turn must not reset the
  // slot count — both calls still belong to one batch.
  const interleaved = normalizeToolLinkage([
    { role: "assistant", kind: "text", payload: "first " },
    { role: "assistant", kind: "tool_call", payload: { name: "a", arguments: "{}", rawLink: "i1" } },
    { role: "assistant", kind: "text", payload: "then " },
    { role: "assistant", kind: "tool_call", payload: { name: "b", arguments: "{}", rawLink: "i2" } }
  ]);
  assert.equal(interleaved[1].payload.slot, "slot:0");
  assert.equal(interleaved[3].payload.slot, "slot:1");

  // A second, later batch restarts the slot counter at 0 independently of the first.
  const twoBatches = normalizeToolLinkage([
    { role: "assistant", kind: "tool_call", payload: { name: "a", arguments: "{}", rawLink: "b1" } },
    { role: "tool", kind: "tool_result", payload: { rawLink: "b1", content: "r1" } },
    { role: "assistant", kind: "tool_call", payload: { name: "c", arguments: "{}", rawLink: "b2" } }
  ]);
  assert.equal(twoBatches[0].payload.slot, "slot:0");
  assert.equal(twoBatches[2].payload.slot, "slot:0");
});

check("buildCompletedPairs: semantic tool descriptor survives truncation into the tool-result pair", () => {
  const scopeId = "test-scope";
  const history = (toolName) => ({
    messages: [
      { role: "user", content: "do it" },
      { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: toolName, arguments: "{\"x\":1}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
      { role: "assistant", content: "done" }
    ]
  });

  const searchPairs = buildCompletedPairs(canonicalizeIncomingHistory(history("search"), "openai"), scopeId);
  const deletePairs = buildCompletedPairs(canonicalizeIncomingHistory(history("delete"), "openai"), scopeId);
  assert.equal(searchPairs.length, 2);
  assert.equal(deletePairs.length, 2);
  assert.notEqual(searchPairs[0], deletePairs[0]);
  // This catches the subtle truncation case: after the original user/tool-call
  // pair is gone, the tool_result->assistant pair still carries the call
  // descriptor, so identical result content and final text cannot collide.
  assert.notEqual(searchPairs[1], deletePairs[1]);
});

check("buildCompletedPairs: same tool name/arguments/result/order fingerprints identically across different opaque transport ids", () => {
  const scopeId = "test-scope";

  // OpenAI: tool_calls[].id / tool_call_id.
  const openaiHistory = (callId) => ({
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: callId, content: "found" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" }
    ]
  });
  const openaiA = buildCompletedPairs(canonicalizeIncomingHistory(openaiHistory("call-A"), "openai"), scopeId);
  const openaiB = buildCompletedPairs(canonicalizeIncomingHistory(openaiHistory("call-B"), "openai"), scopeId);
  assert.equal(openaiA.length, 2);
  assert.deepEqual(openaiA, openaiB);
  // Sanity control: this is not a blanket "ignore tools" collapse — different visible
  // tool semantics (a different tool name) must still diverge.
  const openaiDifferentTool = buildCompletedPairs(canonicalizeIncomingHistory({
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", tool_calls: [{ id: "call-A", type: "function", function: { name: "DIFFERENT_TOOL", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "call-A", content: "found" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" }
    ]
  }, "openai"), scopeId);
  assert.notDeepEqual(openaiA, openaiDifferentTool);

  // Claude: tool_use.id / tool_use_id.
  const claudeHistory = (toolId) => ({
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "lookup", input: { q: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "found" }] },
      { role: "assistant", content: "done" }
    ]
  });
  const claudeA = buildCompletedPairs(canonicalizeIncomingHistory(claudeHistory("tu-A"), "claude"), scopeId);
  const claudeB = buildCompletedPairs(canonicalizeIncomingHistory(claudeHistory("tu-B"), "claude"), scopeId);
  assert.equal(claudeA.length, 2);
  assert.deepEqual(claudeA, claudeB);

  // OpenAI Responses API: call_id.
  const respHistory = (callId) => ({
    input: [
      { role: "user", content: "search" },
      { type: "function_call", call_id: callId, name: "lookup", arguments: "{\"q\":\"x\"}" },
      { type: "function_call_output", call_id: callId, output: "found" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }
    ]
  });
  const respA = buildCompletedPairs(canonicalizeIncomingHistory(respHistory("call-A"), "openai-responses"), scopeId);
  const respB = buildCompletedPairs(canonicalizeIncomingHistory(respHistory("call-B"), "openai-responses"), scopeId);
  assert.equal(respA.length, 2);
  assert.deepEqual(respA, respB);

  // Gemini/Antigravity: functionCall.id. (functionResponse in this codebase correlates
  // by function name, not by a call id, so this specifically proves the CALL's own id
  // no longer affects the hash — the same invariant the other three formats get via
  // real id-based call<->result matching.)
  const agHistory = (callId) => ({
    userAgent: "antigravity",
    request: {
      contents: [
        { role: "user", parts: [{ text: "search" }] },
        { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" }, id: callId } }] },
        { role: "user", parts: [{ functionResponse: { name: "lookup", response: { result: "found" } } }] },
        { role: "model", parts: [{ text: "done" }] }
      ]
    }
  });
  const agA = buildCompletedPairs(canonicalizeIncomingHistory(agHistory("call-A"), "antigravity"), scopeId);
  const agB = buildCompletedPairs(canonicalizeIncomingHistory(agHistory("call-B"), "antigravity"), scopeId);
  assert.equal(agA.length, 2);
  assert.deepEqual(agA, agB);
});

check("buildCompletedPairs: parallel tool calls and out-of-order tool results fingerprint by correct call/result association, not raw ids", () => {
  const scopeId = "test-scope";
  const parallelHistory = (idSearch, idFetch, resultOrder) => {
    const toolMsgs = resultOrder === "search-first"
      ? [
          { role: "tool", tool_call_id: idSearch, content: "search-result" },
          { role: "tool", tool_call_id: idFetch, content: "fetch-result" }
        ]
      : [
          { role: "tool", tool_call_id: idFetch, content: "fetch-result" },
          { role: "tool", tool_call_id: idSearch, content: "search-result" }
        ];
    return {
      messages: [
        { role: "user", content: "do both" },
        { role: "assistant", tool_calls: [
            { id: idSearch, type: "function", function: { name: "search", arguments: "{}" } },
            { id: idFetch, type: "function", function: { name: "fetch", arguments: "{}" } }
          ] },
        ...toolMsgs,
        { role: "assistant", content: "done" }
      ]
    };
  };

  // Different raw ids, same transmission order, same correct call<->result linkage: must match.
  const searchFirstA = buildCompletedPairs(canonicalizeIncomingHistory(parallelHistory("id-1", "id-2", "search-first"), "openai"), scopeId);
  const searchFirstB = buildCompletedPairs(canonicalizeIncomingHistory(parallelHistory("id-X", "id-Y", "search-first"), "openai"), scopeId);
  assert.deepEqual(searchFirstA, searchFirstB);

  // Results transmitted in the opposite order but still correctly linked by id: this
  // is a genuinely different visible request body, so it is allowed (expected) to
  // fingerprint differently from the search-first case above — order is still part of
  // what the client visibly sent — but it must be internally self-consistent across
  // different raw ids, exactly like the search-first case.
  const fetchFirstA = buildCompletedPairs(canonicalizeIncomingHistory(parallelHistory("id-1", "id-2", "fetch-first"), "openai"), scopeId);
  const fetchFirstB = buildCompletedPairs(canonicalizeIncomingHistory(parallelHistory("id-X", "id-Y", "fetch-first"), "openai"), scopeId);
  assert.deepEqual(fetchFirstA, fetchFirstB);
  assert.notDeepEqual(searchFirstA, fetchFirstA);

  // Negative control: swapping WHICH RESULT answers which call is a semantically
  // different exchange (search now "returns" fetch's content) and must diverge — this
  // proves real call<->result association is preserved, not just "ids are ignored".
  const swappedContent = buildCompletedPairs(canonicalizeIncomingHistory({
    messages: [
      { role: "user", content: "do both" },
      { role: "assistant", tool_calls: [
          { id: "id-9", type: "function", function: { name: "search", arguments: "{}" } },
          { id: "id-8", type: "function", function: { name: "fetch", arguments: "{}" } }
        ] },
      { role: "tool", tool_call_id: "id-9", content: "fetch-result" },
      { role: "tool", tool_call_id: "id-8", content: "search-result" },
      { role: "assistant", content: "done" }
    ]
  }, "openai"), scopeId);
  assert.notDeepEqual(searchFirstA, swappedContent);
});

check("normalizeToolLinkage: ambiguous Gemini nameHint stays unlinked and blocks latest continuity match", () => {
  clearContinuityStateForTests();
  const scopeId = "test-scope";
  const priorEvents = canonicalizeIncomingHistory({
    contents: [
      { role: "user", parts: [{ text: "do duplicate-name calls" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "same", args: { x: 1 } } },
          { functionCall: { name: "same", args: { x: 2 } } }
        ]
      }
    ]
  }, "gemini");
  const priorPairs = buildCompletedPairs(priorEvents, scopeId);
  assert.equal(priorPairs.length, 1);
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["prior-thought"],
    finalPairWindow: buildPairWindow(priorPairs),
    continuityCount: 5
  });

  const ambiguousHistory = {
    contents: [
      { role: "user", parts: [{ text: "do duplicate-name calls" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "same", args: { x: 1 } } },
          { functionCall: { name: "same", args: { x: 2 } } }
        ]
      },
      { role: "user", parts: [{ functionResponse: { name: "same", response: { result: "ok" } } }] },
      { role: "model", parts: [{ text: "done" }] }
    ]
  };
  const records = splitCompletedPairs(canonicalizeIncomingHistory(ambiguousHistory, "gemini"));
  assert.equal(records.length, 2);
  assert.deepEqual(records[1].input[0].payload, { unlinked: true, content: "{\"result\":\"ok\"}" });
  const ambiguousPairs = buildCompletedPairs(canonicalizeIncomingHistory(ambiguousHistory, "gemini"), scopeId);
  assert.deepEqual(ambiguousPairs, []);
  assert.equal(resolveContinuityState({ scopeId, completedPairHashes: ambiguousPairs }), null);
  clearContinuityStateForTests();
});

check("buildCompletedPairs: orphan tool_result drops raw linkage and creates no eligible final pair", () => {
  clearContinuityStateForTests();
  const scopeId = "test-scope";
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["prior-thought"],
    finalPairWindow: ["prior-pair"],
    continuityCount: 5
  });

  const events = [
    { role: "tool", kind: "tool_result", payload: { rawLink: "opaque-raw-id", content: "orphan-result" } },
    { role: "assistant", kind: "text", payload: "done" }
  ];
  const records = splitCompletedPairs(events);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].input[0].payload, { unlinked: true, content: "orphan-result" });
  assert.ok(!stableJson(records).includes("opaque-raw-id"));
  const pairs = buildCompletedPairs(events, scopeId);
  assert.deepEqual(pairs, []);
  assert.equal(resolveContinuityState({ scopeId, completedPairHashes: pairs }), null);
  clearContinuityStateForTests();
});

check("analyzeContinuityHistory: trailing unlinked tool_result blocks resolve", () => {
  clearContinuityStateForTests();
  const scopeId = "test-scope";
  const priorHistory = {
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", tool_calls: [{ id: "call-A", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] }
    ]
  };
  const priorPairs = buildCompletedPairs(canonicalizeIncomingHistory(priorHistory, "openai"), scopeId);
  assert.equal(priorPairs.length, 1);
  commitContinuityState({
    scopeId,
    parentState: null,
    responseThoughts: ["prior-thought"],
    finalPairWindow: buildPairWindow(priorPairs),
    continuityCount: 5
  });

  const requestWithUnknownResult = {
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", tool_calls: [{ id: "call-A", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "call-B", content: "unknown result" }
    ]
  };
  const analysis = analyzeContinuityHistory(canonicalizeIncomingHistory(requestWithUnknownResult, "openai"), scopeId);
  assert.equal(analysis.records.length, 1);
  assert.equal(analysis.hasTrailingBarrier, true);
  assert.equal(analysis.canResolve, false);
  assert.deepEqual(analysis.pairHashes, []);
  assert.equal(resolveContinuityState({ scopeId, completedPairHashes: analysis.pairHashes }), null);
  clearContinuityStateForTests();
});

check("analyzeContinuityHistory: unlinked result is a barrier that resets the rolling suffix", () => {
  clearContinuityStateForTests();
  const scopeId = "test-scope";
  const eventsThroughBarrier = canonicalizeIncomingHistory({
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", tool_calls: [{ id: "call-A", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "call-B", content: "unknown result" },
      { role: "assistant", content: "готово" },
      { role: "user", content: "продолжай" }
    ]
  }, "openai");
  const barrierAnalysis = analyzeContinuityHistory(eventsThroughBarrier, scopeId);
  assert.equal(barrierAnalysis.records.length, 2);
  assert.equal(barrierAnalysis.lastBarrierIndex, 1);
  assert.equal(barrierAnalysis.canResolve, false);
  assert.deepEqual(barrierAnalysis.pairHashes, []);

  const userP3 = { role: "user", kind: "text", payload: "продолжай" };
  const assistantP3 = { role: "assistant", kind: "text", payload: "продолжаю" };
  const p3Hash = buildCompletedPairs([userP3, assistantP3], scopeId)[0];
  const commit = commitContinuityFromClientOutput({
    continuityCtx: {
      scopeId,
      incomingEvents: eventsThroughBarrier,
      resolvedState: null,
      continuityCount: 5
    },
    responseThoughts: ["after-barrier"],
    clientOutputEvents: [assistantP3]
  });
  assert.ok(commit);
  assert.equal(commit.pairWindow.length, 1);
  assert.equal(commit.pairWindow[0], p3Hash);

  const nextRequest = canonicalizeIncomingHistory({
    messages: [
      { role: "user", content: "search" },
      { role: "assistant", tool_calls: [{ id: "call-A", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] },
      { role: "tool", tool_call_id: "call-B", content: "unknown result" },
      { role: "assistant", content: "готово" },
      { role: "user", content: "продолжай" },
      { role: "assistant", content: "продолжаю" },
      { role: "user", content: "next" }
    ]
  }, "openai");
  const nextAnalysis = analyzeContinuityHistory(nextRequest, scopeId);
  assert.deepEqual(nextAnalysis.pairHashes, [p3Hash]);
  assert.equal(resolveContinuityState({ scopeId, completedPairHashes: nextAnalysis.pairHashes })?.stateId, commit.stateId);
  clearContinuityStateForTests();
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
