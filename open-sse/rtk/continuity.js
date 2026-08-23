import { injectSystemPrompt } from "./systemInject.js";
import { buildContinuityPrompt } from "./continuityPrompt.js";

export function injectContinuity(body, format, thoughts) {
  injectSystemPrompt(body, format, buildContinuityPrompt(thoughts));
}
