// Parallel tool_use blocks must reach the Claude client one at a time. Each
// block opens, receives its complete arguments and closes before the next
// block opens, and blocks keep the order in which the model produced them.
// Runs on the OpenAI-chunk route and on the direct Kiro route.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const READ_ARGS = '{"Path":"/a.txt"}';
const RUN_ARGS = '{"CommandLine":"ls -la","WaitMsBeforeAsync":500}';
const GREP_ARGS = '{"Query":"TODO"}';

const chunk = (delta, finish_reason = null) => ({
  id: "chatcmpl-parallel",
  object: "chat.completion.chunk",
  created: 1,
  model: "parallel-model",
  choices: [{ index: 0, delta, finish_reason }],
});

const start = (index, id, name) =>
  chunk({ tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] });
const args = (index, text) => chunk({ tool_calls: [{ index, function: { arguments: text } }] });

// Both calls start before either finishes its arguments.
const twoCalls = [
  start(0, "call_read", "read_file"),
  start(1, "call_run", "run_command"),
  args(0, READ_ARGS.slice(0, 9)),
  args(1, RUN_ARGS.slice(0, 20)),
  args(0, READ_ARGS.slice(9)),
  args(1, RUN_ARGS.slice(20)),
];

const threeCalls = [
  start(0, "call_read", "read_file"),
  start(1, "call_run", "run_command"),
  start(2, "call_grep", "grep_search"),
  args(0, READ_ARGS.slice(0, 9)),
  args(1, RUN_ARGS.slice(0, 20)),
  args(2, GREP_ARGS.slice(0, 8)),
  args(0, READ_ARGS.slice(9)),
  args(1, RUN_ARGS.slice(20)),
  args(2, GREP_ARGS.slice(8)),
];

const finish = chunk({}, "tool_calls");

// Feeds chunks through the response translator, as the stream does.
function translate(target, chunks) {
  const state = initState(FORMATS.CLAUDE);
  return chunks.flatMap((c) => translateResponse(target, FORMATS.CLAUDE, c, state) || []);
}

// Only the content block events, in stream order: start, delta, stop.
function blockSequence(events) {
  return events
    .filter((e) => e.type.startsWith("content_block_"))
    .map((e) => e.type.replace("content_block_", ""));
}

// Client rule: a delta belongs to the open block, and a block must close
// before the next one opens.
function replay(events) {
  const blocks = [];
  let open = null;
  for (const event of events) {
    if (event.type === "content_block_start") {
      expect(open, `block ${event.index} opened while block ${open} was open`).toBeNull();
      open = event.index;
      const { type, id, name } = event.content_block;
      blocks.push({ index: event.index, type, id, name, text: "", json: "" });
    } else if (event.type === "content_block_delta") {
      expect(event.index, "delta must target the open block").toBe(open);
      const block = blocks.find((b) => b.index === event.index);
      if (event.delta.type === "text_delta") block.text += event.delta.text;
      if (event.delta.type === "thinking_delta") block.text += event.delta.thinking;
      if (event.delta.type === "input_json_delta") block.json += event.delta.partial_json;
    } else if (event.type === "content_block_stop") {
      expect(event.index, "stop must close the open block").toBe(open);
      open = null;
    }
  }
  expect(open, "a block was left open").toBeNull();
  return blocks;
}

const readBlock = (index) => ({ index, type: "tool_use", id: "call_read", name: "read_file", text: "", json: READ_ARGS });
const runBlock = (index) => ({ index, type: "tool_use", id: "call_run", name: "run_command", text: "", json: RUN_ARGS });
const grepBlock = (index) => ({ index, type: "tool_use", id: "call_grep", name: "grep_search", text: "", json: GREP_ARGS });

const ROUTES = [
  ["OpenAI chunks", FORMATS.OPENAI],
  ["Kiro direct chunks", FORMATS.KIRO],
];

describe.each(ROUTES)("parallel tool_use blocks on the %s route", (_label, target) => {
  it("two parallel calls: start1, delta1, stop1, start2, delta2, stop2", () => {
    const events = translate(target, [...twoCalls, finish]);
    expect(blockSequence(events)).toEqual(["start", "delta", "stop", "start", "delta", "stop"]);
    expect(replay(events)).toEqual([readBlock(0), runBlock(1)]);
  });

  it("three parallel calls: each block keeps its own arguments, in order", () => {
    const events = translate(target, [...threeCalls, finish]);
    expect(blockSequence(events)).toEqual([
      "start", "delta", "stop", "start", "delta", "stop", "start", "delta", "stop",
    ]);
    expect(replay(events)).toEqual([readBlock(0), runBlock(1), grepBlock(2)]);
  });

  it("thinking before parallel calls closes before the first tool opens", () => {
    const events = translate(target, [chunk({ reasoning_content: "Plan. " }), ...twoCalls, finish]);
    expect(replay(events)).toEqual([
      { index: 0, type: "thinking", text: "Plan. ", json: "" },
      readBlock(1),
      runBlock(2),
    ]);
  });

  it("text before and after parallel calls keeps the model's block order", () => {
    const events = translate(target, [
      chunk({ content: "Checking. " }),
      ...twoCalls,
      chunk({ content: "Done." }),
      finish,
    ]);
    expect(replay(events)).toEqual([
      { index: 0, type: "text", text: "Checking. ", json: "" },
      readBlock(1),
      runBlock(2),
      { index: 3, type: "text", text: "Done.", json: "" },
    ]);
  });
});
