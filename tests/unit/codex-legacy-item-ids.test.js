import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

const credentials = { connectionId: "legacy-item-fixture", accessToken: "fixture-token" };
const user = { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] };
afterEach(() => vi.restoreAllMocks());

describe("Codex legacy reasoning IDs", () => {
  it("removes only legacy reasoning IDs and preserves continuity and order", () => {
    const encrypted = "opaque-redacted-encrypted-content";
    const body = new CodexExecutor().transformRequest("gpt-5.5", {
      model: "gpt-5.5", instructions: "fixture", tools: [], input: [
        user,
        { type: "reasoning", id: "item_legacy", summary: [], encrypted_content: encrypted },
        { type: "reasoning", id: "rs_saved", summary: [], encrypted_content: encrypted },
        { type: "function_call", id: "item_call", call_id: "call_preserved", name: "tool", arguments: "{}" },
        { type: "function_call_output", call_id: "call_preserved", output: "ok" },
      ],
    }, true, credentials);
    expect(body.input.map(item => item.type)).toEqual(["message", "reasoning", "reasoning", "function_call", "function_call_output"]);
    expect(body.input[1].id).toBeUndefined();
    expect(body.input[2].id).toBeUndefined();
    expect(body.input[1].encrypted_content).toBe(encrypted);
    expect(body.input[2].encrypted_content).toBe(encrypted);
    expect(body.input[3]).toMatchObject({ id: "item_call", call_id: "call_preserved", arguments: "{}" });
    expect(body.input[4]).toMatchObject({ call_id: "call_preserved", output: "ok" });
  });

  it("preserves the Lite developer msg ID exception", () => {
    const body = new CodexExecutor().transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol", instructions: "", tools: [], input: [
        { type: "message", role: "developer", id: "msg_lite_prefix", content: [{ type: "input_text", text: "fixture" }] },
        user,
      ],
    }, true, credentials);
    expect(body.input.some(item => item.id === "msg_lite_prefix")).toBe(true);
  });

  it("sends normalized reasoning through execute to an ID-validating stub", async () => {
    const encrypted = "opaque-redacted";
    const fetch = vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (_url, options) => {
      const request = JSON.parse(options.body);
      const reasoning = request.input.find(item => item.type === "reasoning");
      expect(reasoning.id).toBeUndefined();
      expect(reasoning.encrypted_content).toBe(encrypted);
      return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n', {
        status: 200, headers: { "Content-Type": "text/event-stream" },
      });
    });
    const result = await new CodexExecutor().execute({
      model: "gpt-5.5", stream: true, credentials,
      body: { model: "gpt-5.5", input: [user, { type: "reasoning", id: "item_legacy", summary: [], encrypted_content: encrypted }] },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(200);
  });
});
