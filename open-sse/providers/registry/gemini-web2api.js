// Gemini-Web2API (https://github.com/Mag1cFall/Gemini-Web2API): a local bridge to Google Gemini
// Web on 127.0.0.1:8007. Kept distinct from upstream's `gemini-web` Playwright cookie provider so
// upstream protocol implementations remain intact. Speaks the bridge's Gemini-native `/v1beta`
// wire and discovers its unseeded model list dynamically from `/v1/models`.
import { FORMATS } from "../../translator/formats.js";

export default {
  id: "gemini-web2api",
  priority: 65,
  alias: "gemini-web2api",
  aliases: ["g2a"],
  display: {
    name: "Gemini-Web2API",
    icon: "diamond",
    color: "#1A73E8",
    textIcon: "G2",
    website: "https://github.com/Mag1cFall/Gemini-Web2API",
    notice: {
      text: "Local bridge on 127.0.0.1:8007 (Gemini-native wire). The API key is PROXY_API_KEY from the bridge's env file.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "http://127.0.0.1:8007/v1beta/models",
    format: FORMATS.GEMINI,
    validateUrl: "http://127.0.0.1:8007/v1/models",
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
