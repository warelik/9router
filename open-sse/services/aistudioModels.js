import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { FETCH_CONNECT_TIMEOUT_MS, HTTP_STATUS } from "../config/runtimeConfig.js";

// The registry is intentionally unseeded; keep bridge model IDs opaque.
export async function resolveAIStudioModels(credentials, options = {}) {
  const apiKey = credentials?.apiKey;
  if (!apiKey) {
    return { error: "No valid token found", status: HTTP_STATUS.UNAUTHORIZED };
  }
  const res = await proxyAwareFetch(PROVIDERS.aistudio.validateUrl, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS),
  }, options.proxyOptions || null);
  if (!res.ok) {
    return { error: `Failed to fetch models: ${res.status}`, status: res.status };
  }
  const data = await res.json();
  const rows = (Array.isArray(data?.data) ? data.data : [])
    .filter((entry) => typeof entry?.id === "string" && entry.id.length > 0);
  return {
    models: rows.map((entry) => ({
      ...entry,
      name: entry.name || entry.display_name || entry.id,
    })),
  };
}
