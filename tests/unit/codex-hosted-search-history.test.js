import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

const credentials = { connectionId: "fixture", accessToken: "fixture-token" };
afterEach(() => vi.restoreAllMocks());

const USER_MSG = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
const HOSTED_SEARCH = { type: "web_search_call", id: "ws_1", status: "completed" };

describe("Codex hosted search history forces regular transport", () => {
  it("declares web_search when a Lite request history contains web_search_call items", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol",
      input: [USER_MSG, HOSTED_SEARCH],
      instructions: "Client instructions",
      tools: [],
    }, true, credentials);

    expect(body.tools).toContainEqual({ type: "web_search" });
    expect(body.tools.filter(t => t.type === "web_search")).toHaveLength(1);
    expect(body.input.some(item => item.type === "additional_tools")).toBe(false);
    expect(body.input.some(item => item.type === "web_search_call")).toBe(true);
    expect(body.instructions).toBe("Client instructions");
    const headers = executor.buildHeaders(credentials, true, null, "gpt-6.1-sol", body);
    expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
  });

  it("keeps the Lite shape when the same request has no web_search_call history", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol",
      input: [USER_MSG],
      instructions: "Client instructions",
      tools: [],
    }, true, credentials);

    expect(body.tools).toBeNull();
    expect(body.input[0].type).toBe("additional_tools");
    expect(body.instructions).toBe("");
    const headers = executor.buildHeaders(credentials, true, null, "gpt-6.1-sol", body);
    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it("converts an existing Lite prefix to regular tools without duplicates", () => {
    const executor = new CodexExecutor();
    const fn = { type: "function", name: "run", parameters: { type: "object", properties: {} } };
    const body = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol",
      input: [
        { type: "additional_tools", role: "developer", tools: [fn] },
        USER_MSG,
        HOSTED_SEARCH,
      ],
      instructions: "",
      tools: [],
    }, true, credentials);

    expect(body.tools).toHaveLength(2);
    expect(body.tools.filter(t => t.type === "web_search")).toHaveLength(1);
    expect(body.tools).toContainEqual(fn);
    expect(body.input.some(item => item.type === "additional_tools")).toBe(false);
    const headers = executor.buildHeaders(credentials, true, null, "gpt-6.1-sol", body);
    expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
  });

  it("does not inject web_search into compact requests", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol",
      input: [USER_MSG, HOSTED_SEARCH],
      instructions: "",
      tools: [],
      _compact: true,
    }, true, credentials);

    const tools = Array.isArray(body.tools) ? body.tools : [];
    expect(tools.some(t => t.type === "web_search")).toBe(false);
    const headers = executor.buildHeaders(credentials, true, null, "gpt-6.1-sol", body);
    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it("declares web_search for non-Lite cx models too", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: [USER_MSG, HOSTED_SEARCH],
      tools: [],
    }, true, credentials);

    expect(body.tools).toContainEqual({ type: "web_search" });
    expect(body.input.some(item => item.type === "web_search_call")).toBe(true);
  });
});
