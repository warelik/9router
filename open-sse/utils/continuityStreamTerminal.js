import { FORMATS } from "../translator/formats.js";
import { isOpenAIResponsesTerminalEvent } from "./responsesStreamHelpers.js";

export function isContinuityProtocolTerminal(parsed, { targetFormat = null, eventName = null, sawOpenAIResponsesEvent = false } = {}) {
  if (!parsed || typeof parsed !== "object") return false;

  if (isOpenAIResponsesTerminalEvent(eventName || parsed.type, parsed)) {
    return true;
  }

  // `[DONE]` is terminal for OpenAI-style chat streams, but not enough for
  // Responses streams where response.completed/failed carries the logical end.
  if (parsed.done === true) {
    return targetFormat !== FORMATS.OPENAI_RESPONSES && !sawOpenAIResponsesEvent;
  }

  if (parsed.type === "message_stop") return true;
  if (Array.isArray(parsed.choices) && parsed.choices.some(choice => choice?.finish_reason)) return true;
  if (Array.isArray(parsed.candidates) && parsed.candidates.some(candidate => candidate?.finishReason || candidate?.finish_reason)) return true;

  return false;
}
