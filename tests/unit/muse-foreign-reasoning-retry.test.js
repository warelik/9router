import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { MuseExecutor, sanitizeMuseForeignReasoning, dropMuseReasoningReferences, dropMuseReasoningItems } = await import("../../open-sse/executors/muse.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

const FOREIGN_ERROR = {
  error: {
    code: null,
    message: "reasoning `encrypted_content` was not issued to this caller",
    param: null,
    type: "invalid_request_error",
  },
};

const EXPIRED_ERROR = {
  error: {
    code: null,
    message: "Referenced reasoning item 'rs_stale' was not found or has expired.",
    param: null,
    type: "invalid_request_error",
  },
};

function makeExpiredBody() {
  return {
    model: "muse-spark-1.3-contributor",
    stream: false,
    store: false,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      {
        type: "reasoning",
        id: "rs_stale",
        summary: [{ type: "summary_text", text: "stale plan" }],
      },
      {
        type: "reasoning",
        id: "rs_current",
        status: "completed",
        summary: [{ type: "summary_text", text: "current plan" }],
        encrypted_content: "current-blob",
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
}

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeBody() {
  return {
    model: "muse-wonder-1.0-contributor",
    stream: false,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high", summary: "auto" },
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      {
        type: "reasoning",
        id: "rs_foreign",
        status: "completed",
        summary: [{ type: "summary_text", text: "prior plan" }],
        encrypted_content: "foreign-blob",
      },
      {
        type: "reasoning",
        id: "rs_empty",
        status: "completed",
        summary: [],
        encrypted_content: "foreign-empty",
      },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
}

function makeArgs(body, overrides = {}) {
  return {
    model: "muse-wonder-1.0-contributor",
    body,
    stream: false,
    credentials: {
      accessToken: "test-only-caller-b",
      connectionId: "muse-connection-b",
      providerSpecificData: {},
      runtimeTransport: {
        baseUrl: "https://api.meta.ai/v1/responses",
        format: "openai-responses",
        headers: {},
        auth: { combined: true, header: "Authorization", scheme: "bearer", hooks: ["museHeaders"] },
      },
    },
    providerSessionId: "session-1",
    log: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function sentBody(callIndex) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

describe("Muse foreign reasoning recovery", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("registers the dedicated Muse executor", () => {
    expect(getExecutor("muse")).toBeInstanceOf(MuseExecutor);
  });

  it("keeps encrypted reasoning intact on a successful first attempt", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: "resp_ok", status: "completed", output: [] }));
    const executor = new MuseExecutor();

    const out = await executor.execute(makeArgs(makeBody()));

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(0).input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", encrypted_content: "foreign-blob" }),
    ]));
  });

  it("retries only after Meta rejects foreign encrypted reasoning", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, FOREIGN_ERROR))
      .mockResolvedValueOnce(response(200, { id: "resp_retry", status: "completed", output: [] }));
    const executor = new MuseExecutor();

    const out = await executor.execute(makeArgs(makeBody()));

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(0).input).toEqual(expect.arrayContaining([
      expect.objectContaining({ encrypted_content: "foreign-blob" }),
    ]));

    const retryInput = sentBody(1).input;
    expect(JSON.stringify(retryInput)).not.toContain("foreign-blob");
    expect(JSON.stringify(retryInput)).not.toContain("foreign-empty");
    expect(retryInput).toEqual(expect.arrayContaining([
      {
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "prior plan" }],
      },
      expect.objectContaining({ type: "function_call", call_id: "call_1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    ]));
    expect(retryInput.filter((item) => item.type === "reasoning")).toHaveLength(1);
  });

  it("pre-strips only hashes already rejected for this session and caller", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, FOREIGN_ERROR))
      .mockResolvedValueOnce(response(200, { id: "resp_retry", status: "completed", output: [] }))
      .mockResolvedValueOnce(response(200, { id: "resp_next", status: "completed", output: [] }));
    const executor = new MuseExecutor();

    await executor.execute(makeArgs(makeBody()));

    const nextBody = makeBody();
    nextBody.input.splice(3, 0, {
      type: "reasoning",
      id: "rs_current",
      status: "completed",
      summary: [{ type: "summary_text", text: "current plan" }],
      encrypted_content: "current-caller-blob",
    });
    const out = await executor.execute(makeArgs(nextBody));

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sent = sentBody(2);
    expect(JSON.stringify(sent.input)).not.toContain("foreign-blob");
    expect(sent.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", encrypted_content: "current-caller-blob" }),
    ]));
  });

  it("does not retry unrelated 400 errors", async () => {
    fetchMock.mockResolvedValueOnce(response(400, { error: { message: "unknown parameter" } }));
    const executor = new MuseExecutor();

    const out = await executor.execute(makeArgs(makeBody()));

    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizer preserves summaries and drops empty reasoning items", () => {
    const { body, removedHashes } = sanitizeMuseForeignReasoning(makeBody());

    expect(removedHashes).toHaveLength(2);
    expect(body.input.filter((item) => item.type === "reasoning")).toEqual([{
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "prior plan" }],
    }]);
  });

  it("retries without the referenced item after Meta reports it expired", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, EXPIRED_ERROR))
      .mockResolvedValueOnce(response(200, { id: "resp_retry", status: "completed", output: [] }));
    const executor = new MuseExecutor();

    const out = await executor.execute(makeArgs(makeExpiredBody()));

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInput = sentBody(1).input;
    expect(JSON.stringify(retryInput)).not.toContain("rs_stale");
    expect(retryInput).toEqual(expect.arrayContaining([
      { type: "reasoning", summary: [{ type: "summary_text", text: "stale plan" }] },
      expect.objectContaining({ type: "reasoning", id: "rs_current", encrypted_content: "current-blob" }),
    ]));
  });

  it("pre-strips expired references already rejected for this caller", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, EXPIRED_ERROR))
      .mockResolvedValueOnce(response(200, { id: "resp_retry", status: "completed", output: [] }))
      .mockResolvedValueOnce(response(200, { id: "resp_next", status: "completed", output: [] }));
    const executor = new MuseExecutor();

    await executor.execute(makeArgs(makeExpiredBody()));
    const out = await executor.execute(makeArgs(makeExpiredBody()));

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(sentBody(2).input)).not.toContain("rs_stale");
    expect(JSON.stringify(sentBody(2).input)).toContain("current-blob");
  });

  it("reference dropper keeps summaries and removes only named ids", () => {
    const { body, removedIds } = dropMuseReasoningReferences(
      makeExpiredBody(),
      new Set(["rs_stale"]),
    );

    expect(removedIds).toEqual(["rs_stale"]);
    expect(body.input.filter((item) => item.type === "reasoning")).toEqual([
      { type: "reasoning", summary: [{ type: "summary_text", text: "stale plan" }] },
      expect.objectContaining({ type: "reasoning", id: "rs_current" }),
    ]);
  });

  // Regression (2026-11-08): the original one-shot recovery returned the
  // first foreign-reasoning 400 whenever its single retry also failed,
  // whatever the retry's actual outcome was. Two live requests died that
  // way while the same sanitized body is accepted by Meta on replay.
  it("escalates to dropping reasoning items when summary-only replay is still rejected", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, FOREIGN_ERROR))
      .mockResolvedValueOnce(response(400, FOREIGN_ERROR))
      .mockResolvedValueOnce(response(200, { id: "resp_escalated", status: "completed", output: [] }));
    const executor = new MuseExecutor();

    const out = await executor.execute(makeArgs(makeBody()));

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdInput = sentBody(2).input;
    expect(thirdInput.filter((item) => item.type === "reasoning")).toHaveLength(0);
    expect(thirdInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    ]));
  });

  it("recovers a composite foreign-then-expired rejection in one execution", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, FOREIGN_ERROR))
      .mockResolvedValueOnce(response(400, EXPIRED_ERROR))
      .mockResolvedValueOnce(response(200, { id: "resp_composite", status: "completed", output: [] }));
    const executor = new MuseExecutor();

    const body = makeBody();
    body.input.splice(3, 0, {
      type: "reasoning",
      id: "rs_stale",
      summary: [{ type: "summary_text", text: "stale plan" }],
    });
    const out = await executor.execute(makeArgs(body));

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdInput = sentBody(2).input;
    expect(JSON.stringify(thirdInput)).not.toContain("foreign-blob");
    expect(JSON.stringify(thirdInput)).not.toContain("rs_stale");
    expect(thirdInput.filter((item) => item.type === "reasoning")).toEqual([
      { type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "prior plan" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "stale plan" }] },
    ]);
  });

  it("does not mask a transport failure of the recovery attempt as the first 400", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, FOREIGN_ERROR))
      .mockRejectedValueOnce(new Error("fetch failed"));
    const executor = new MuseExecutor();

    await expect(executor.execute(makeArgs(makeBody()))).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the recovery attempt's own error instead of the first rejection", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, FOREIGN_ERROR))
      .mockResolvedValueOnce(response(400, {
        error: { message: "The request contains invalid parameters." },
      }));
    const executor = new MuseExecutor();

    const out = await executor.execute(makeArgs(makeBody()));

    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const returned = await out.response.text();
    expect(returned).toContain("invalid parameters");
    expect(returned).not.toContain("was not issued to this caller");
  });

  it("reasoning item dropper removes reasoning items and strips encrypted payloads", () => {
    const { body, removedItems, removedHashes } = dropMuseReasoningItems(makeBody());

    expect(removedHashes).toHaveLength(2);
    expect(removedItems).toBe(1);
    expect(body.input.some((item) => item.type === "reasoning")).toBe(false);
    expect(JSON.stringify(body.input)).not.toContain("foreign-blob");
    expect(body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    ]));
  });

  it("classifies Muse foreign/expired reasoning rejections as caller-scoped", () => {
    const foreign = checkFallbackError(400, FOREIGN_ERROR.error.message, 0, "muse");
    expect(foreign.shouldFallback).toBe(true);
    expect(foreign.cooldownMs).toBe(0);
    expect(foreign.requestScoped).toBeFalsy();

    const expired = checkFallbackError(400, EXPIRED_ERROR.error.message, 0, "muse");
    expect(expired.shouldFallback).toBe(true);
    expect(expired.cooldownMs).toBe(0);
    expect(expired.requestScoped).toBeFalsy();

    const generic = checkFallbackError(400, "The request contains invalid parameters.", 0, "muse");
    expect(generic.requestScoped).toBe(true);
    expect(generic.shouldFallback).toBe(false);

    const otherProvider = checkFallbackError(400, FOREIGN_ERROR.error.message, 0, "openai");
    expect(otherProvider.requestScoped).toBe(true);
    expect(otherProvider.shouldFallback).toBe(false);
  });
});
