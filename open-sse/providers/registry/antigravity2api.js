// Antigravity2API (https://github.com/Mag1cFall/Antigravity2API): a local bridge to Google
// Antigravity accounts on 127.0.0.1:8017. Kept distinct from upstream's `antigravity` OAuth
// provider so upstream protocol implementations remain intact. Speaks the bridge's
// Gemini-native `/v1beta` wire and discovers its unseeded model list dynamically from `/v1/models`.
import { FORMATS } from "../../translator/formats.js";

export default {
  id: "antigravity2api",
  priority: 70,
  alias: "antigravity2api",
  aliases: ["ag2"],
  display: {
    name: "Antigravity2API",
    icon: "diamond",
    color: "#F59E0B",
    textIcon: "AG",
    website: "https://github.com/Mag1cFall/Antigravity2API",
    notice: {
      text: "Local bridge on 127.0.0.1:8017 (Gemini-native wire). The API key is one of API_KEYS from the bridge's env file.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "http://127.0.0.1:8017/v1beta/models",
    format: FORMATS.GEMINI,
    validateUrl: "http://127.0.0.1:8017/v1/models",
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
