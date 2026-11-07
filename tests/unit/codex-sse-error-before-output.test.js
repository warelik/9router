import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const credentials = { connectionId: "fixture", accessToken: "fixture-token" };
afterEach(() => vi.restoreAllMocks());

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseResponse(text) {
  return new Response(streamFromText(text), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const INTERNAL_ERROR_SSE = [
  "event: error",
  'data: {"type":"error","error":{"message":"response protection is unavailable","type":"internal_error"}}',
  "",
].join("\n");

const INVALID_REQUEST_SSE = [
  "event: error",
  'data: {"type":"error","error":{"message":"No tool output found for function call call_1","type":"invalid_request_error"}}',
  "",
].join("\n");

const RESPONSE_FAILED_SSE = [
  "event: response.failed",
  'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"upstream exploded"}}}',
  "",
].join("\n");

describe("Codex SSE error events before user output", () => {
  it("maps a terminal internal_error event to 502 with the upstream message", async () => {
    const peek = await new CodexExecutor()._peekSseTransientError(sseResponse(INTERNAL_ERROR_SSE));
    expect(peek.status).toBe(502);
    expect(peek.accountFallback).toBe(false);
    expect(peek.message).toBe("response protection is unavailable");
  });

  it("maps an invalid_request_error event to 400", async () => {
    const peek = await new CodexExecutor()._peekSseTransientError(sseResponse(INVALID_REQUEST_SSE));
    expect(peek.status).toBe(400);
    expect(peek.message).toBe("No tool output found for function call call_1");
  });

  it("maps response.failed with a nested error to 502 and its message", async () => {
    const peek = await new CodexExecutor()._peekSseTransientError(sseResponse(RESPONSE_FAILED_SSE));
    expect(peek.status).toBe(502);
    expect(peek.message).toBe("upstream exploded");
  });

  it("streams an error that follows user-visible output through untouched", async () => {
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
      "event: error",
      'data: {"type":"error","error":{"message":"response protection is unavailable","type":"internal_error"}}',
      "",
    ].join("\n");
    const peek = await new CodexExecutor()._peekSseTransientError(sseResponse(text));
    expect(peek.matched).toBeNull();
    expect(peek.status).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("keeps the capacity pattern as account fallback even inside an error event", async () => {
    const peek = await new CodexExecutor()._peekSseTransientError(sseResponse([
      "event: error",
      'data: {"type":"error","error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")));
    expect(peek.accountFallback).toBe(true);
    expect(peek.status).toBeNull();
  });

  it("keeps the overload pattern as a retryable transient match", async () => {
    const peek = await new CodexExecutor()._peekSseTransientError(sseResponse([
      "event: error",
      'data: {"type":"error","error":{"type":"server_is_overloaded","message":"overloaded"}}',
      "",
    ].join("\n")));
    expect(peek.matched).toBe("server_is_overloaded");
    expect(peek.accountFallback).toBe(false);
    expect(peek.status).toBeNull();
  });

  it("execute() turns a terminal SSE error into a JSON error response without retrying", async () => {
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch")
      .mockResolvedValue(sseResponse(INTERNAL_ERROR_SSE));
    const result = await new CodexExecutor().execute({
      model: "gpt-6.1-sol",
      body: { model: "gpt-6.1-sol", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true, credentials,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toBe("response protection is unavailable");
  });

  it("a combo falls back to the next model when the first returns 200 + SSE internal_error", async () => {
    const okSse = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const fetchMock = vi.spyOn(proxyFetchModule, "proxyAwareFetch");
    fetchMock
      .mockResolvedValueOnce(sseResponse(INTERNAL_ERROR_SSE))
      .mockResolvedValueOnce(sseResponse(okSse));

    const executor = new CodexExecutor();
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const result = await handleComboChat({
      body: { model: "combo", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      models: ["codex/gpt-5.5", "codex/gpt-5.6-sol"],
      handleSingleModel: async (body, modelStr) => {
        const r = await executor.execute({
          model: modelStr.split("/")[1],
          body: { ...body, model: modelStr.split("/")[1] },
          stream: true, credentials, log,
        });
        return r.response;
      },
      log,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(log.info.mock.calls.some(c => String(c[1]).includes("codex/gpt-5.6-sol succeeded"))).toBe(true);
    expect(log.info.mock.calls.some(c => String(c[1]).includes("codex/gpt-5.5 succeeded"))).toBe(false);
    await expect(result.text()).resolves.toBe(okSse);
  });
});
