// AIStudioToAPI (https://github.com/iBUHub/AIStudioToAPI): a local bridge that drives Google AI
// Studio in a browser. Only its Gemini-native `/v1beta` surface returns the real
// `thoughtSignature` of a thinking turn; its OpenAI and Claude surfaces drop it (or fake it), and
// without it the model cannot use its own earlier reasoning. So this provider talks Gemini wire.
// The model list is whatever the bridge serves, hence passthroughModels and no seeded ids.
export default {
  id: "aistudio",
  priority: 60,
  alias: "aistudio",
  display: {
    name: "AIStudioToAPI",
    icon: "diamond",
    color: "#4285F4",
    textIcon: "AS",
    website: "https://github.com/iBUHub/AIStudioToAPI",
    notice: {
      text: "Local bridge on 127.0.0.1:7860 (Gemini-native wire). The API key is one of API_KEYS from the bridge's env file.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "http://127.0.0.1:7860/v1beta/models",
    format: "gemini",
    validateUrl: "http://127.0.0.1:7860/v1/models",
    auth: {
      apiKey: {
        header: "x-goog-api-key",
        scheme: "raw",
      },
    },
  },
  models: [],
  passthroughModels: true,
};
