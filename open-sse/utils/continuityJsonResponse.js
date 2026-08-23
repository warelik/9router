import { canonicalizeClientOutput } from "./continuityCanonicalizer.js";
import { commitContinuityFromClientOutput } from "./continuityStore.js";
import { collectResponseThoughts, createStreamingThoughtAccumulator } from "./continuityThoughtCollector.js";
import { stripTaggedThinking } from "./taggedThinkingNormalizer.js";

/**
 * Read an independent clone of the provider response and capture semantic
 * reasoning before any client-format projection. The clone is consumed in
 * parallel with the real response so forced-SSE JSON paths do not buffer an
 * unconsumed tee branch.
 */
export async function collectProviderResponseThoughts(response) {
  if (!response) return [];
  const raw = await response.text();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return collectResponseThoughts(parsed).map((thought) => thought.text);
  } catch {
    // Streaming responses are handled below, one semantic data frame at a time.
  }

  const accumulator = createStreamingThoughtAccumulator();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      accumulator.push(JSON.parse(payload));
    } catch {
      // Malformed/provider-comment frames are ignored exactly like the stream parser.
    }
  }
  return accumulator.finalize();
}

/**
 * Normalize the actual JSON body returned to the client and commit continuity
 * from that exact body. Fail open: continuity telemetry must never break a
 * successfully completed provider request.
 */
export async function finalizeContinuityJsonResult({ result, continuityCtx, responseThoughtsPromise, sourceFormat }) {
  if (!continuityCtx || !result?.success || !result.response) return result;

  try {
    const clientBody = await result.response.clone().json();
    const tagsStripped = stripTaggedThinking(clientBody);
    const responseThoughts = await Promise.resolve(responseThoughtsPromise).catch(() => []);
    const clientOutputEvents = canonicalizeClientOutput(clientBody, sourceFormat);
    commitContinuityFromClientOutput({ continuityCtx, responseThoughts, clientOutputEvents });

    if (tagsStripped) {
      const headers = new Headers(result.response.headers);
      headers.delete("content-length");
      result.response = new Response(JSON.stringify(clientBody), {
        status: result.response.status,
        statusText: result.response.statusText,
        headers
      });
    }
  } catch (error) {
    continuityCtx.log?.warn?.("CONTINUITY", `[SKIP-COMMIT] req=${continuityCtx.requestLogToken || "?"} json=${error?.message || "unreadable"}`);
  }
  return result;
}
