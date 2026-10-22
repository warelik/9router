import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({ get: async () => null, set: async () => {}, remove: async () => {}, getAll: async () => ({}) }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { buildStreamErrorBytes } = await import("../../open-sse/utils/streamHelpers.js");
const { createStreamController, pipeWithDisconnect } = await import("../../open-sse/utils/streamHandler.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const encode = text => new TextEncoder().encode(text);
const frame = body => `data: ${JSON.stringify(body)}\r\n\r\n`;
const chunk = {
  responseId: "native-response",
  candidates: [{ index: 0, content: { role: "model", parts: [
    { text: "проверка", thought: true, thoughtSignature: "opaque-native-signature" },
    { functionCall: { id: "original-call-id", name: "init_worker", args: { task: { message: "INITIALIZATION_TASK", nested: [1, false] } } }, thoughtSignature: "opaque-tool-signature" },
    { functionResponse: { id: "original-result-id", name: "other_worker", response: { result: "DEPENDENT_RESULT" } } },
    { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
    { futureNativeField: { future: true } },
  ] }, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["query"] } }],
  modelVersion: "gemini-native-test",
};
const lateUsage = { usageMetadata: { promptTokenCount: 4096, candidatesTokenCount: 7, thoughtsTokenCount: 20, cachedContentTokenCount: 2048, totalTokenCount: 4123 } };
const inputStream = chunks => new ReadableStream({ start(controller) { for (const value of chunks) controller.enqueue(value); controller.close(); } });
const nativeTransform = (provider, source = FORMATS.GEMINI, complete = null, nativeJson = false, projection = null, onNativeResponseSuccess = null) => createPassthroughStreamWithLogger(provider, null, "gemini-native-test", null, null, complete, null, source, nativeJson, projection, onNativeResponseSuccess);
const readText = stream => new Response(stream).text();

describe("native Gemini SSE preserves provider payload and follows the client protocol", () => {
  it.each(["gemini", "aistudio", "future-native-provider"])("does not append Chat DONE or mutate Parts/usage through %s", async provider => {
    const original = frame(chunk) + frame(lateUsage);
    const bytes = encode(original);
    const completed = vi.fn();
    const output = await readText(inputStream(Array.from(bytes, value => Uint8Array.of(value))).pipeThrough(nativeTransform(provider, FORMATS.GEMINI, completed)));
    expect(output).toBe(original);
    expect(output).not.toContain("[DONE]");
    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0][0]).toEqual({ content: "", thinking: "проверка" });
    expect(completed.mock.calls[0][1].cached_tokens).toBe(2048);
  });

  it.each([FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY])("uses EOF rather than DONE for %s even on an unknown provider", async source => {
    const original = frame({ response: chunk }) + frame({ response: lateUsage });
    expect(await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("unlisted-provider", source)))).toBe(original);
  });

  it("preserves an EOF tail without a newline and captures its late usage", async () => {
    const original = frame(chunk) + `data: ${JSON.stringify(lateUsage)}`;
    const completed = vi.fn();
    expect(await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, completed)))).toBe(original);
    expect(completed.mock.calls[0][1].cached_tokens).toBe(2048);
  });

  it("accepts upstream DONE after a complete Antigravity-native response", async () => {
    const original = frame({ response: chunk }) + frame({ response: lateUsage }) + "data: [DONE]\r\n\r\n";
    const output = await readText(inputStream(Array.from(encode(original), byte => Uint8Array.of(byte)))
      .pipeThrough(nativeTransform("antigravity", FORMATS.ANTIGRAVITY)));
    expect(output).toBe(original);
    expect(output).not.toContain('"code":502');
  });

  it("does not let upstream DONE complete an unfinished native candidate", async () => {
    const original = frame({ response: { candidates: [{ index: 0,
      content: { role: "model", parts: [{ text: "unfinished" }] },
    }] } }) + "data: [DONE]\r\n\r\n";
    const output = await readText(inputStream([encode(original)])
      .pipeThrough(nativeTransform("antigravity", FORMATS.ANTIGRAVITY)));
    expect(output.startsWith(original)).toBe(true);
    expect(output.slice(original.length)).toContain('"code":502');
    expect(output.slice(original.length)).toContain("before a candidate finished");
  });

  it("preserves unknown fields, SSE comments and multiline JSON exactly", async () => {
    const partial = frame({ candidates: [{ index: 0, content: { parts: [{ text: "prefix" }] } }] });
    const original = partial + ': heartbeat\n\ndata: {"candidates":[\ndata: {"index":0,"finishReason":"STOP","futureField":true}]}\n\n';
    expect(await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("aistudio")))).toBe(original);
  });

  it("keeps a Gemini upstream Chat client terminated with Chat DONE", async () => {
    const original = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n';
    const output = await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("gemini", FORMATS.OPENAI)));
    expect(output).toContain('"content":"hi"');
    expect(output.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("keeps upstream native errors and details without a synthetic success", async () => {
    const original = frame({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ retryDelay: "2s" }] } });
    expect(await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("aistudio")))).toBe(original);
  });

  it("expresses premature EOF as native failure after retaining partial content", async () => {
    const partial = frame({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "partial" }] } }] });
    const output = await readText(inputStream([encode(partial)]).pipeThrough(nativeTransform("aistudio")));
    expect(output.startsWith(partial)).toBe(true);
    const error = JSON.parse(output.slice(partial.length).trim().slice(5));
    expect(error.error).toMatchObject({ code: 502, message: expect.stringContaining("before a candidate finished") });
    expect(output).not.toContain("[DONE]");
  });

  it("tracks separate candidates without accepting one terminal as another's completion", async () => {
    const prefix = frame({ candidates: [{ index: 0, finishReason: "STOP" }, { index: 1, content: { parts: [{ text: "partial" }] } }] });
    const incomplete = await readText(inputStream([encode(prefix)]).pipeThrough(nativeTransform("aistudio")));
    expect(incomplete).toContain('"code":502');
    const complete = prefix + frame({ candidates: [{ index: 1, finishReason: "STOP" }] }) + frame(lateUsage);
    expect(await readText(inputStream([encode(complete)]).pipeThrough(nativeTransform("aistudio")))).toBe(complete);
  });

  it("does not treat the unspecified finish-reason enum as a terminal", async () => {
    const partial = { candidates: [{ index: 0, finishReason: "FINISH_REASON_UNSPECIFIED", content: { parts: [{ text: "partial" }] } }] };
    const terminal = { candidates: [{ index: 0, finishReason: "STOP" }] };
    const sse = frame(partial);
    const failed = await readText(inputStream([encode(sse)]).pipeThrough(nativeTransform("gemini")));
    expect(failed.startsWith(sse)).toBe(true);
    expect(failed).toContain('"code":502');
    await expect(readText(inputStream([encode(JSON.stringify([partial]))])
      .pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, true)))).rejects.toThrow("before a candidate finished");
    const completeSse = sse + frame(terminal);
    expect(await readText(inputStream([encode(completeSse)]).pipeThrough(nativeTransform("gemini")))).toBe(completeSse);
    const completeJson = JSON.stringify([partial, terminal]);
    expect(await readText(inputStream([encode(completeJson)]).pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, true)))).toBe(completeJson);
  });

  it.each([
    { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [{ index: 0, finishReason: "SAFETY", safetyRatings: [{ blocked: true }] }] },
    lateUsage,
  ])("does not fabricate failure for a refusal, empty finished candidate or usage-only response", async body => {
    const original = frame(body);
    expect(await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("aistudio")))).toBe(original);
  });
});

describe("native response projections preserve requested data without inventing completion failures", () => {
  const filtered = { candidates: [{ content: { parts: [{ text: "completed projected answer" }] } }] };

  it.each([
    "candidates/content/parts/text",
    "candidates.content.parts.text",
    "candidates(content(parts(text)))",
    "modelVersion,candidates(content/parts/text)",
    "future_selector[0]",
  ])("preserves a finished response with unobservable finishReason under %s", async mask => {
    for (const nativeJson of [false, true]) {
      const original = nativeJson ? JSON.stringify([filtered]) : frame(filtered);
      const output = await readText(inputStream([encode(original)])
        .pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, nativeJson, { masks: [mask] })));
      expect(output).toBe(original);
    }
  });

  it.each([
    "*",
    "candidates",
    "candidates/*",
    "candidates.finishReason",
    "candidates/finish_reason",
    "candidates(finishReason,content)",
    "candidates(content(parts(text)),finishReason)",
    "candidates(*)",
    "",
  ])("still rejects incomplete candidates when %s exposes the native terminal", async mask => {
    const original = frame(filtered);
    const output = await readText(inputStream([encode(original)])
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, false, { masks: [mask] })));
    expect(output.startsWith(original)).toBe(true);
    expect(output.slice(original.length)).toContain('"code":502');
    await expect(readText(inputStream([encode(JSON.stringify([filtered]))])
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, true, { masks: [mask] })))).rejects.toThrow("before a candidate finished");
  });

  it("does not infer terminal visibility from conflicting query and header projections", async () => {
    const original = frame(filtered);
    const output = await readText(inputStream([encode(original)])
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, false, { masks: ["candidates/finishReason", "candidates/content"] })));
    expect(output).toBe(original);
  });

  it("does not assign terminal chunks to positions when a multi-candidate projection hides index", async () => {
    const responses = [
      { candidates: [
        { content: { parts: [{ text: "first candidate" }] } },
        { content: { parts: [{ text: "second candidate" }] } },
      ] },
      { candidates: [{ finishReason: "STOP" }] },
      { candidates: [{ finishReason: "STOP" }] },
    ];
    for (const nativeJson of [false, true]) {
      const original = nativeJson ? JSON.stringify(responses) : responses.map(frame).join("");
      expect(await readText(inputStream([encode(original)])
        .pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, nativeJson, { masks: ["candidates(content,finishReason)"] })))).toBe(original);
    }
  });

  it("still rejects an indexed unfinished candidate when index is included in the projection", async () => {
    const responses = [
      { candidates: [
        { index: 0, content: { parts: [{ text: "first candidate" }] } },
        { index: 1, content: { parts: [{ text: "unfinished second candidate" }] } },
      ] },
      { candidates: [{ index: 0, finishReason: "STOP" }] },
    ];
    const projection = { masks: ["candidates(content,finishReason,index)"] };
    const original = responses.map(frame).join("");
    const output = await readText(inputStream([encode(original)])
      .pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, false, projection)));
    expect(output.startsWith(original)).toBe(true);
    expect(output.slice(original.length)).toContain('"code":502');
    await expect(readText(inputStream([encode(JSON.stringify(responses))])
      .pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, true, projection)))).rejects.toThrow("before a candidate finished");
  });

  it("requires at least one visible terminal for multiple candidates even when their index is hidden", async () => {
    const response = { candidates: [
      { content: { parts: [{ text: "first partial candidate" }] } },
      { content: { parts: [{ text: "second partial candidate" }] } },
    ] };
    const projection = { masks: ["candidates(content,finishReason)"] };
    const original = frame(response);
    const output = await readText(inputStream([encode(original)])
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, false, projection)));
    expect(output.startsWith(original)).toBe(true);
    expect(output.slice(original.length)).toContain('"code":502');
    await expect(readText(inputStream([encode(JSON.stringify([response]))])
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, true, projection)))).rejects.toThrow("before a candidate finished");
  });

  it.each(["", ": heartbeat\n\n"])("reports a native failure for empty SSE transport %j even under a projection", async raw => {
    const output = await readText(inputStream([encode(raw)])
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, false, { masks: ["candidates/content"] })));
    expect(output.startsWith(raw)).toBe(true);
    expect(output.slice(raw.length)).toContain('"code":502');
    expect(output).not.toContain("[DONE]");
  });

  it.each(["", "[]", '[{"candidates":['])('keeps projected malformed or empty JSON %j as an error, without SSE bytes', async raw => {
    await expect(readText(inputStream([encode(raw)])
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, true, { masks: ["candidates/content"] })))).rejects.toThrow(/Upstream Gemini JSON stream/);
  });

  it("preserves a projected empty object returned for an absent optional field", async () => {
    expect(await readText(inputStream([encode("{}")])
      .pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, true, { masks: ["modelStatus"] })))).toBe("{}");
    const original = frame({});
    expect(await readText(inputStream([encode(original)])
      .pipeThrough(nativeTransform("gemini", FORMATS.GEMINI, null, false, { masks: ["modelStatus"] })))).toBe(original);
  });

  it.each([
    ["empty object", "{}"],
    ["empty array", "[]"],
    ["number", "17"],
    ["null", "null"],
    ["empty wrapped object", '{"response":{}}'],
  ])("rejects a native SSE %s frame instead of accepting it as a response", async (_name, payload) => {
    const original = `data: ${payload}\n\n`;
    const output = await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("aistudio")));
    expect(output.startsWith(original)).toBe(true);
    expect(output.slice(original.length)).toContain('"code":502');
  });

  it("retains provider errors and details when finishReason is excluded", async () => {
    const failure = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ retryDelay: "2s" }] } };
    for (const nativeJson of [false, true]) {
      const original = nativeJson ? JSON.stringify(failure) : frame(failure);
      expect(await readText(inputStream([encode(original)])
        .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, nativeJson, { masks: ["candidates/content"] })))).toBe(original);
    }
  });

  it("still reports upstream aborts on a projected JSON response", async () => {
    let pulls = 0;
    const upstream = new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(encode(JSON.stringify([filtered])));
      else controller.error(new Error("socket hang up"));
    } });
    const controller = createStreamController({ provider: "aistudio", model: "test", log: { errorLine: vi.fn() } });
    const result = await handleStreamingResponse({
      providerResponse: new Response(upstream, { headers: { "Content-Type": "application/json" } }),
      provider: "aistudio", model: "test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), streamController: controller,
      nativeResponseProjection: { masks: ["candidates/content"] },
    });
    await expect(result.response.text()).rejects.toThrow("socket hang up");
  });
});

describe("native stream integration and failure cleanup", () => {
  it("preserves an upstream HTML 403 as a native error and never reports request success", async () => {
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response("<html><title>Forbidden</title></html>", { status: 403, headers: { "Content-Type": "text/html" } }),
      provider: "aistudio", model: "test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), onRequestSuccess: succeeded,
      streamController: createStreamController({ provider: "aistudio", model: "test", log: { errorLine: vi.fn() } }),
      log: { errorLine: vi.fn() },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject({ error: { code: 403, status: "PERMISSION_DENIED", message: expect.stringContaining("Forbidden") } });
    expect(succeeded).not.toHaveBeenCalled();
  });

  it("reports native request success only after consuming a validated terminal response", async () => {
    const original = frame(chunk) + frame(lateUsage);
    const succeeded = vi.fn();
    const controller = createStreamController({ provider: "aistudio", model: "gemini-native-test" });
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(original)]), { headers: { "content-type": "text/event-stream" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: { contents: [{ role: "user", parts: [{ text: "task" }] }] }, stream: true, requestStartTime: Date.now(),
      streamController: controller, onRequestSuccess: succeeded,
    });
    expect(result.success).toBe(true);
    expect(succeeded).not.toHaveBeenCalled();
    expect(await result.response.text()).toBe(original);
    await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
  });

  it("defers native request success through the same-format tool-name transform", async () => {
    const toolNameMap = new Map([["wire_tool", "original_tool"]]);
    const response = { candidates: [{ index: 0, content: { role: "model", parts: [
      { functionCall: { id: "call-1", name: "wire_tool", args: { value: 1 } } },
    ] }, finishReason: "STOP" }] };
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(frame(response))]), { headers: { "content-type": "text/event-stream" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), toolNameMap,
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });

    expect(succeeded).not.toHaveBeenCalled();
    const output = await result.response.text();
    expect(output).toContain('"functionCall":{"id":"call-1","name":"original_tool"');
    await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
  });

  it.each([
    ["native error envelope", frame({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } })],
    ["malformed native data", "data: {not-json}\n\n"],
    ["unfinished native candidate", frame({ candidates: [{ index: 0, content: { parts: [{ text: "partial" }] } }] })],
  ])("does not report native request success through the tool-name transform for %s", async (_name, raw) => {
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "content-type": "text/event-stream" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), toolNameMap: new Map([["wire_tool", "original_tool"]]),
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });

    await result.response.text();
    expect(succeeded).not.toHaveBeenCalled();
  });

  it("validates native JSON at EOF and restores tool names through the same-format transform", async () => {
    const toolNameMap = new Map([["wire_tool", "original_tool"]]);
    const native = {
      candidates: [{ index: 0, content: { role: "model", parts: [
        { text: "valid answer" },
        { functionCall: { name: "wire_tool", args: { value: 1 } } },
      ] }, finishReason: "STOP" }],
      futureNativeField: { retained: true },
    };
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(JSON.stringify(native))]), { headers: { "content-type": "application/json" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), toolNameMap,
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });

    expect(succeeded).not.toHaveBeenCalled();
    const output = JSON.parse(await result.response.text());
    expect(output.candidates[0].content.parts).toEqual([
      { text: "valid answer" },
      { functionCall: { name: "original_tool", args: { value: 1 } } },
    ]);
    expect(output.futureNativeField).toEqual(native.futureNativeField);
    await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
  });

  it("reports a valid native JSON refusal only after the tool-name transform reaches EOF", async () => {
    const native = { promptFeedback: { blockReason: "SAFETY" }, futureNativeField: true };
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(JSON.stringify(native))]), { headers: { "content-type": "application/json" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), toolNameMap: new Map([["wire_tool", "original_tool"]]),
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });

    expect(succeeded).not.toHaveBeenCalled();
    expect(JSON.parse(await result.response.text())).toEqual(native);
    await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
  });

  it.each([
    ["native error envelope", JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }), false],
    ["malformed JSON", "{not-json", true],
    ["malformed candidate list", JSON.stringify({ candidates: {} }), true],
    ["unfinished candidate", JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: "partial" }] } }] }), true],
  ])("does not report native JSON request success through the tool-name transform for %s", async (_name, raw, rejects) => {
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "content-type": "application/json" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), toolNameMap: new Map([["wire_tool", "original_tool"]]),
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });

    if (rejects) {
      await expect(result.response.text()).rejects.toThrow("Upstream Gemini JSON stream");
    } else {
      expect(JSON.parse(await result.response.text())).toEqual({
        error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" },
      });
    }
    expect(succeeded).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON terminal candidate", "application/json", JSON.stringify(chunk)],
    ["JSON safety refusal", "application/json", JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })],
    ["SSE safety refusal", "text/event-stream", frame({ promptFeedback: { blockReason: "SAFETY" } })],
  ])("reports native request success at accepted EOF for a valid %s", async (_name, contentType, raw) => {
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "content-type": contentType } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(),
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });
    expect(succeeded).not.toHaveBeenCalled();
    expect(await result.response.text()).toBe(raw);
    await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
  });

  it.each([
    ["finishReason is masked", frame({ candidates: [{ content: { parts: [{ text: "projected answer" }] } }] }), { masks: ["candidates/content/parts/text"] }],
    ["the selected empty object is masked", frame({}), { masks: ["modelStatus"] }],
    ["a null response wrapper falls back to its nonempty outer object", frame({ response: null }), null],
  ])("reports native success at accepted EOF when %s", async (_name, raw, nativeResponseProjection) => {
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "content-type": "text/event-stream" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), nativeResponseProjection,
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });
    expect(succeeded).not.toHaveBeenCalled();
    expect(await result.response.text()).toBe(raw);
    await vi.waitFor(() => expect(succeeded).toHaveBeenCalledOnce());
  });

  it.each([
    ["HTTP 200 native error", frame(chunk) + frame({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }), "quota"],
    ["native error with malformed candidate field", frame({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" }, candidates: {} }), "quota"],
    ["malformed data after a terminal", frame(chunk) + "data: {not-json}\n\n", '"code":502'],
    ["non-array candidate list", frame({ candidates: {} }), '"code":502'],
    ["null candidate entry", frame({ candidates: [null] }), '"code":502'],
    ["candidate without a terminal", frame({ candidates: [{ index: 0, content: { parts: [{ text: "partial" }] } }] }), "before a candidate finished"],
  ])("does not report native request success for %s", async (_name, raw, expectedFailure) => {
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "content-type": "text/event-stream" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(),
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });
    const output = await result.response.text();
    expect(output).toContain(expectedFailure);
    expect(succeeded).not.toHaveBeenCalled();
  });

  it.each([
    ["empty object", "{}"],
    ["empty array", "[]"],
    ["scalar", "17"],
    ["array with empty object", "[{}]"],
    ["array with scalar", "[17]"],
    ["empty wrapped object", '{"response":{}}'],
    ["non-array candidate list", '{"candidates":{}}'],
    ["null candidate entry", '{"candidates":[null]}'],
  ])("does not report native request success for JSON %s", async (_name, raw) => {
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "content-type": "application/json" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(),
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });
    await expect(result.response.text()).rejects.toThrow("Upstream Gemini JSON stream returned no valid response");
    expect(succeeded).not.toHaveBeenCalled();
  });

  it("preserves a native JSON error with malformed candidate fields without reporting success", async () => {
    const raw = JSON.stringify({
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" },
      candidates: {},
    });
    const succeeded = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "content-type": "application/json" } }),
      provider: "aistudio", model: "gemini-native-test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(),
      streamController: createStreamController({ provider: "aistudio", model: "gemini-native-test", log: { errorLine: vi.fn() } }),
      onRequestSuccess: succeeded,
    });
    expect(await result.response.text()).toBe(raw);
    expect(succeeded).not.toHaveBeenCalled();
  });

  it.each([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY])("builds a native numeric abort error without DONE for %s", source => {
    const output = new TextDecoder().decode(buildStreamErrorBytes(504, "stream stall timeout", source));
    expect(JSON.parse(output.trim().slice(5))).toEqual({ error: { code: 504, message: "stream stall timeout" } });
    expect(output).not.toContain("[DONE]");
  });

  it("cancels an active native upstream when the client disconnects", async () => {
    const cancelled = vi.fn();
    const disconnected = vi.fn();
    const controller = createStreamController({ provider: "aistudio", model: "test", onDisconnect: disconnected });
    const upstream = new ReadableStream({ start(c) { c.enqueue(encode(frame(chunk))); }, cancel: cancelled });
    const output = pipeWithDisconnect({ body: upstream }, nativeTransform("aistudio"), controller, message => buildStreamErrorBytes(504, message, FORMATS.GEMINI), 5000);
    const reader = output.getReader();
    await reader.read();
    await reader.cancel("fixture client disconnected");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("aborts a stalled native generation and emits a parseable error without DONE", async () => {
    const controller = createStreamController({ provider: "aistudio", model: "test", log: { errorLine: vi.fn() } });
    const upstream = new ReadableStream({ start(c) { c.enqueue(encode(frame(chunk))); controller.signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true }); } });
    const output = pipeWithDisconnect({ body: upstream }, nativeTransform("aistudio"), controller, message => buildStreamErrorBytes(504, message, FORMATS.GEMINI), 30);
    const text = await readText(output);
    expect(text).toContain('"code":504');
    expect(text).toContain('"stream stall timeout"');
    expect(text).not.toContain("[DONE]");
    expect(controller.signal.aborted).toBe(true);
  });

  it("preserves a complete JSON-framed native stream and its media type", async () => {
    const original = `[ ${JSON.stringify(chunk)}, ${JSON.stringify(lateUsage)} ]`;
    const controller = createStreamController({ provider: "aistudio", model: "test" });
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(original)]), { headers: { "Content-Type": "application/json" } }),
      provider: "aistudio", model: "test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), streamController: controller,
    });
    expect(result.response.headers.get("content-type")).toBe("application/json");
    expect(await result.response.text()).toBe(original);
  });

  it("captures JSON-array usage and thoughts while preserving byte-fragmented UTF-8 and multiline framing", async () => {
    const original = JSON.stringify([chunk, lateUsage], null, 2);
    const complete = vi.fn();
    const bytes = encode(original);
    const output = await readText(inputStream(Array.from(bytes, value => Uint8Array.of(value)))
      .pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, complete, true)));
    expect(output).toBe(original);
    expect(complete.mock.calls[0][0].thinking).toBe("проверка");
    expect(complete.mock.calls[0][1].cached_tokens).toBe(2048);
  });

  it.each([
    ["empty transport", ""],
    ["empty response array", "[]"],
    ["empty response object", "{}"],
    ["scalar response", "17"],
    ["array containing an empty object", "[{}]"],
    ["array containing a scalar", "[17]"],
    ["incomplete JSON", '[{"candidates":['],
    ["unfinished candidate in syntactically valid JSON", JSON.stringify([{ candidates: [{ index: 0, content: { parts: [{ text: "partial" }] } }] }])],
  ])("rejects %s at clean native JSON EOF", async (_name, raw) => {
    const controller = createStreamController({ provider: "aistudio", model: "test", log: { errorLine: vi.fn() } });
    const result = await handleStreamingResponse({
      providerResponse: new Response(inputStream([encode(raw)]), { headers: { "Content-Type": "application/json" } }),
      provider: "aistudio", model: "test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), streamController: controller,
    });
    await expect(result.response.text()).rejects.toThrow(/Upstream Gemini JSON stream/);
  });

  it.each([
    { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [{ index: 0, finishReason: "SAFETY", content: { parts: [] } }] },
    lateUsage,
  ])("accepts valid JSON refusals, empty finished candidates and usage-only native responses", async response => {
    const original = JSON.stringify(response);
    expect(await readText(inputStream([encode(original)]).pipeThrough(nativeTransform("aistudio", FORMATS.GEMINI, null, true)))).toBe(original);
  });

  it("rejects a JSON-framed native stream interrupted by an upstream network error", async () => {
    let pulls = 0;
    const upstream = new ReadableStream({ pull(c) {
      if (pulls++ === 0) c.enqueue(encode('[{"candidates":['));
      else c.error(new Error("socket hang up"));
    } });
    const controller = createStreamController({ provider: "aistudio", model: "test", log: { errorLine: vi.fn() } });
    const result = await handleStreamingResponse({
      providerResponse: new Response(upstream, { headers: { "Content-Type": "application/json" } }),
      provider: "aistudio", model: "test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), streamController: controller,
    });
    expect(result.response.headers.get("content-type")).toBe("application/json");
    await expect(result.response.text()).rejects.toThrow("socket hang up");
  });

  it("rejects native JSON consumption on a stall instead of appending an SSE error or closing successfully", async () => {
    const controller = createStreamController({ provider: "aistudio", model: "test", log: { errorLine: vi.fn() } });
    const upstream = new ReadableStream({ start(c) {
      c.enqueue(encode('[{"candidates":['));
      controller.signal.addEventListener("abort", () => c.error(new Error("aborted native JSON")), { once: true });
    } });
    const output = pipeWithDisconnect({ body: upstream }, nativeTransform("aistudio"), controller, null, 30, true);
    await expect(readText(output)).rejects.toThrow("aborted native JSON");
    expect(controller.signal.aborted).toBe(true);
  });

  it("cancels the provider while a client is reading a partial native JSON array", async () => {
    const cancelled = vi.fn();
    const controller = createStreamController({ provider: "aistudio", model: "test" });
    const upstream = new ReadableStream({ start(c) { c.enqueue(encode('[{"candidates":[')); }, cancel: cancelled });
    const result = await handleStreamingResponse({
      providerResponse: new Response(upstream, { headers: { "Content-Type": "application/json" } }),
      provider: "aistudio", model: "test", sourceFormat: FORMATS.GEMINI, targetFormat: FORMATS.GEMINI,
      body: {}, stream: true, requestStartTime: Date.now(), streamController: controller,
    });
    const reader = result.response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('[{"candidates":[');
    await reader.cancel("client JSON reader cancelled");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});
