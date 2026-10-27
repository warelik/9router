import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { convertResponsesApiFormat, normalizeResponsesAgentMessage, toPortableResponsesInput } from "../../open-sse/translator/formats/responsesApi.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { hasUndeliverableAgentMessage, preparePortableCollaboration } from "../../open-sse/translator/concerns/portableCollaboration.js";

const FERNET = "gAAAAABrXy-opaque-cipher";
const REASONING_BLOB = "gAAAAAB_reasoning_opaque_blob";

const headerFor = (type, task, sender) => `Message Type: ${type}\nTask name: ${task}\nSender: ${sender}`;

const agent = (type, author, recipient, payload) => ({
  type: "agent_message",
  author,
  recipient,
  content: [
    { type: "input_text", text: headerFor(type, "delivery_probe", author) },
    { type: "encrypted_content", encrypted_content: payload },
  ],
});

const newTask = agent("NEW_TASK", "/root", "/root/delivery_probe", "Reply with exactly DELIVERY_OK.");
const message = agent("MESSAGE", "/root", "/root/delivery_probe", "Follow-up note.");
const finalAnswer = agent("FINAL_ANSWER", "/root/delivery_probe", "/root", "Result: DELIVERY_OK.");

const clone = (value) => structuredClone(value);
const textOf = (msg) => (Array.isArray(msg.content) ? msg.content.map((p) => p.text).join("\n") : msg.content);
const nativeContents = (out, format) => (format === FORMATS.ANTIGRAVITY ? out.request.contents : out.contents);

describe("normalizeResponsesAgentMessage", () => {
  it("returns non-agent items as the same object", () => {
    const item = { type: "function_call", call_id: "c1", name: "x", arguments: "{}" };
    expect(normalizeResponsesAgentMessage(item)).toBe(item);
    const msg = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
    expect(normalizeResponsesAgentMessage(msg)).toBe(msg);
  });

  it.each([
    ["NEW_TASK", newTask],
    ["MESSAGE", message],
    ["FINAL_ANSWER", finalAnswer],
  ])("turns a %s plaintext carrier into an exact user message", (_label, item) => {
    const out = normalizeResponsesAgentMessage(item);
    expect(out).toEqual({
      type: "message",
      role: "user",
      author: item.author,
      recipient: item.recipient,
      content: [
        { type: "input_text", text: item.content[0].text },
        { type: "input_text", text: item.content[1].encrypted_content },
      ],
    });
  });

  it("keeps Fernet ciphertext opaque", () => {
    const out = normalizeResponsesAgentMessage({
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: FERNET }],
    });
    expect(out.content).toEqual([{ type: "encrypted_content", encrypted_content: FERNET }]);
  });
});

describe("agent_message plaintext task delivery", () => {
  const cases = [
    ["NEW_TASK", newTask, "/root", "/root/delivery_probe"],
    ["MESSAGE", message, "/root", "/root/delivery_probe"],
    ["FINAL_ANSWER", finalAnswer, "/root/delivery_probe", "/root"],
  ];

  it.each(cases)("%s header and payload appear exactly once, in order, via convertResponsesApiFormat", (_label, item) => {
    const body = { model: "m", input: [item] };
    const before = clone(body);
    const out = convertResponsesApiFormat(body);
    expect(out.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: item.content[0].text },
        { type: "text", text: item.content[1].encrypted_content },
      ],
    }]);
    expect(body).toEqual(before);
  });

  it.each(cases)("%s header and payload appear exactly once via openaiResponsesToOpenAIRequest", (_label, item) => {
    const body = { model: "m", input: [item] };
    const before = clone(body);
    const out = openaiResponsesToOpenAIRequest("m", body, true, {});
    expect(textOf(out.messages[0])).toBe(`${item.content[0].text}\n${item.content[1].encrypted_content}`);
    expect(out.messages).toHaveLength(1);
    expect(body).toEqual(before);
  });

  it("preserves escaped Unicode, newlines and trailing spaces byte for byte", () => {
    const tricky = agent("NEW_TASK", "/root", "/root/delivery_probe", "l\u00ednea \u2603  \n\ttab  ");
    const out = openaiResponsesToOpenAIRequest("m", { model: "m", input: [tricky] }, true, {});
    expect(textOf(out.messages[0])).toBe(`${tricky.content[0].text}\nl\u00ednea \u2603  \n\ttab  `);
  });

  it("keeps the agent task after a real tool call and output, before assistant output", () => {
    const input = [
      { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
      newTask,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ];
    const out = convertResponsesApiFormat({ model: "m", input });
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant"]);
    expect(textOf(out.messages[2])).toContain("DELIVERY_OK");
  });

  it("keeps ordinary reasoning opaque and attached to the next assistant, never as user text", () => {
    const input = [
      newTask,
      { type: "reasoning", encrypted_content: REASONING_BLOB, summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ];
    const out = openaiResponsesToOpenAIRequest("m", { model: "m", input }, true, {});
    const userTexts = out.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m));
    expect(userTexts.join("\n")).not.toContain(REASONING_BLOB);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.encrypted_content).toBe(REASONING_BLOB);
  });

  it("keeps a plaintext-only carrier as one user text part through the portable path", () => {
    const only = { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "plain payload" }] };
    expect(toPortableResponsesInput([only])).toEqual([{
      type: "message", role: "user", content: [{ type: "input_text", text: "plain payload" }],
    }]);
    const out = convertResponsesApiFormat({ model: "m", input: [only] });
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "plain payload" }] }]);
  });

  it("keeps the existing Fernet portable outcomes unchanged", () => {
    const mixed = { type: "agent_message", content: [
      { type: "input_text", text: "kept" },
      { type: "encrypted_content", encrypted_content: FERNET },
    ] };
    expect(toPortableResponsesInput([mixed])).toEqual([{
      type: "message", role: "user", content: [{ type: "input_text", text: "kept" }],
    }]);
    const onlyFernet = { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: FERNET }] };
    expect(toPortableResponsesInput([onlyFernet])).toEqual([]);
  });

  it("does not mutate the caller's body deeply", () => {
    const body = { model: "m", input: [clone(newTask), clone(message), clone(finalAnswer)] };
    const before = JSON.stringify(body);
    openaiResponsesToOpenAIRequest("m", body, true, {});
    convertResponsesApiFormat(clone(body));
    toPortableResponsesInput(body.input);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("keeps the native Responses pass-through untouched", () => {
    const body = { model: "m", input: [clone(newTask)] };
    const before = JSON.stringify(body);
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "m", body, true, {}, "openai");
    expect(JSON.stringify(out.input)).toBe(JSON.stringify([newTask]));
    expect(JSON.stringify(body)).toBe(before);
  });

  it.each([
    [FORMATS.GEMINI, "gemini"],
    [FORMATS.GEMINI, "aistudio"],
    [FORMATS.ANTIGRAVITY, "antigravity"],
  ])("delivers the task once to native %s/%s contents with thinkingLevel high", (format, provider) => {
    const body = { model: "gemini-3.8-flash", input: [clone(newTask)], reasoning: { effort: "high" } };
    const before = JSON.stringify(body);
    const out = translateRequest(FORMATS.OPENAI_RESPONSES, format, "gemini-3.8-flash", body, true, {}, provider);
    const contents = nativeContents(out, format);
    const texts = contents.flatMap((c) => c.parts.map((p) => p.text)).filter(Boolean);
    expect(texts.filter((t) => t.startsWith("Message Type: NEW_TASK"))).toHaveLength(1);
    expect(texts.filter((t) => t === "Reply with exactly DELIVERY_OK.")).toHaveLength(1);
    const generation = format === FORMATS.ANTIGRAVITY ? out.request.generationConfig : out.generationConfig;
    expect(generation.thinkingConfig.thinkingLevel).toBe("high");
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("opaque agent_message detection", () => {
  const opaqueAgent = type => agent(type, "/root", "/root/delivery_probe", FERNET);

  it.each(["NEW_TASK", "MESSAGE", "FINAL_ANSWER"])("flags opaque %s agent messages", type => {
    expect(hasUndeliverableAgentMessage([opaqueAgent(type)])).toBe(true);
  });

  it("flags Fernet-only agent content", () => {
    expect(hasUndeliverableAgentMessage([{ type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: FERNET }] }])).toBe(true);
  });

  it("keeps an opaque agent message with an image deliverable", () => {
    const withImage = { type: "agent_message", content: [
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "encrypted_content", encrypted_content: FERNET },
    ] };
    expect(hasUndeliverableAgentMessage([withImage])).toBe(false);
  });

  it("ignores plaintext agent messages, ordinary reasoning ciphertext and non-array input", () => {
    expect(hasUndeliverableAgentMessage([newTask, message, finalAnswer])).toBe(false);
    expect(hasUndeliverableAgentMessage([{ type: "reasoning", encrypted_content: REASONING_BLOB, summary: [] }])).toBe(false);
    expect(hasUndeliverableAgentMessage("text")).toBe(false);
  });

  it("returns the same body and an empty map when no collaboration tools are present", () => {
    const body = { model: "m", tools: [{ type: "function", name: "read", parameters: { type: "object" } }], input: [clone(newTask)] };
    const out = preparePortableCollaboration(body);
    expect(out.body).toBe(body);
    expect(out.toolNameMap.size).toBe(0);
  });

  it("keeps readable mixed and plaintext carriers deliverable", () => {
    const mixed = { type: "agent_message", content: [{ type: "input_text", text: "delegated ask" }, { type: "encrypted_content", encrypted_content: FERNET }] };
    const plaintext = { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "plain task" }, { type: "encrypted_content", encrypted_content: FERNET }] };
    expect(hasUndeliverableAgentMessage([mixed])).toBe(false);
    expect(hasUndeliverableAgentMessage([plaintext])).toBe(false);
  });

  it("requires readable payload beyond the metadata envelope", () => {
    const envelope = payload => ({ type: "agent_message", content: [
      { type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\n\nPayload:${payload}` },
      { type: "encrypted_content", encrypted_content: FERNET },
    ] });
    expect(hasUndeliverableAgentMessage([envelope("")])).toBe(true);
    expect(hasUndeliverableAgentMessage([envelope(" Reply READY")])).toBe(false);
  });

  it("treats a metadata envelope split across input_text parts as metadata only", () => {
    expect(hasUndeliverableAgentMessage([{ type: "agent_message", content: [
      { type: "input_text", text: "Message Type: NEW_TASK" },
      { type: "input_text", text: "Task name: /root/probe" },
      { type: "input_text", text: "Sender: /root" },
      { type: "encrypted_content", encrypted_content: FERNET },
    ] }])).toBe(true);
  });
});
