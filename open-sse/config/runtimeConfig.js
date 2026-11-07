import { FORMATS } from "../translator/formats.js";

// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  CLIENT_CLOSED_REQUEST: 499,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Combo empty-content failover: how long a 2xx stream may be held while waiting for its first
// content-bearing frame before committing to that model (fail-open on expiry).
// Env: EMPTY_PEEK_DEADLINE_MS.
export const EMPTY_PEEK_DEADLINE_MS = envMs("EMPTY_PEEK_DEADLINE_MS", 45 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;
export const DEFAULT_PROVIDER_THINKING_BUDGET = 10000;

export const FILE_EXTENSION_MIME = {
  pdf: "application/pdf", json: "application/json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4",
  txt: "text/plain", md: "text/markdown", csv: "text/csv",
};

export const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
export const SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
export const SCHEMA_SINGLE_KEYS = new Set(["items", "additionalProperties", "contains", "not", "if", "then", "else"]);
export const PROTO_SCHEMA_TYPES = new Set(["OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN", "NULL"]);
export const LEGACY_PROTO_SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "items", "properties", "required", "propertyOrdering"]);


export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

export const PORTABLE_COLLABORATION = {
  header: "x-9router-portable-collaboration",
  namespace: "collaboration",
  messageTools: ["spawn_agent", "send_message", "followup_task"],
  aliasPrefix: "collab_plain_",
  aliasHashLength: 16,
  aliasNameLength: 30,
  aliasCollisionBaseLength: 58,
};

export const RESPONSES_NAMESPACE_ALIAS = {
  prefix: "ns_",
  stemLength: 40,
  hashLength: 16,
  maxLength: 64,
};

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
// Transient 429/5xx are NOT retried on the same account: the router switches
// to the next account immediately (account fallback), and the failed account
// cools down via ERROR_RULES instead of burning the request's latency budget
// on repeat attempts against the endpoint that just rejected it.
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 0, delayMs: 0 },
  503: { attempts: 0, delayMs: 0 },
  504: { attempts: 0, delayMs: 0 }
};

// How long a chat request may wait for a free account (polling account locks)
// instead of surfacing a 429/503 to the client. Only after this deadline does
// the router give up, answering 502 rather than the upstream 429/503.
// Env: ACCOUNT_WAIT_DEADLINE_MS. 0 disables waiting.
// Parsed separately from envMs: 0 must stay 0 (disables waiting), not fall back.
export const ACCOUNT_WAIT_DEADLINE_MS = (() => {
  const raw = process.env.ACCOUNT_WAIT_DEADLINE_MS;
  if (raw == null || raw === "") return 10 * 60 * 1000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000;
})();

// Per-model share of the wait deadline inside a combo: a member whose
// accounts are all busy waits at most this long before the combo moves to the
// next member; when every member is busy the combo waits and re-passes the
// member list until ACCOUNT_WAIT_DEADLINE_MS expires. Env: COMBO_MODEL_WAIT_MS.
export const COMBO_MODEL_WAIT_MS = envMs("COMBO_MODEL_WAIT_MS", 20 * 1000);

// Maximum request starts per account per rolling minute. An account at the
// limit is skipped during selection (like a locked account) until its oldest
// start leaves the window, spreading bursts across accounts before the
// provider's own rate limit fires. Env: ACCOUNT_START_LIMIT_PER_MIN.
export const ACCOUNT_START_LIMIT_PER_MIN = envMs("ACCOUNT_START_LIMIT_PER_MIN", 30);

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];

export const FERNET_ENCRYPTED_CONTENT_PREFIX = "gAAAAA";

export const SSE_DONE_PAYLOAD = "[DONE]";
export const SSE_DONE = `data: ${SSE_DONE_PAYLOAD}\n\n`;

export const NATIVE_GEMINI_PRIVATE_HEADERS = new Set([
  "authorization", "proxy-authorization", "x-goog-api-key", "x-api-key", "cookie", "set-cookie",
  "host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer",
]);

export const NATIVE_GEMINI_THINKING_KEYS = ["thinkingLevel", "thinking_level", "thinkingBudget", "thinking_budget"];

export const NATIVE_GEMINI_RESPONSE_FIELDS = ["candidates", "promptFeedback", "usageMetadata", "modelVersion", "responseId", "modelStatus", "createTime"];
export const NATIVE_GEMINI_BRIDGE_FIELDS = new Set(["message", "event", "data", "status", "code", "success", "response"]);

export const NATIVE_GEMINI_ERROR_STATUSES = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

export const NATIVE_GEMINI_API_VERSIONS = ["v1", "v1alpha"];
export const NATIVE_GEMINI_FIELD_MASK_QUERY_NAMES = ["fields", "$fields"];
export const NATIVE_GEMINI_FIELD_MASK_HEADER_NAME = "x-goog-fieldmask";
export const NATIVE_GEMINI_JSON_FENCE_PENDING_STATES = ["start", "possible", "open"];
export const NATIVE_GEMINI_FINISH_REASON_FIELDS = ["finishReason", "finish_reason"];
export const NATIVE_GEMINI_CANDIDATE_MASK_PREFIXES = ["*", "candidates", "candidates/*"];
export const NATIVE_GEMINI_FORMATS = [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY];
export const REWRITTEN_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];
export const AISTUDIO_NATIVE_GEMINI_API_VERSION = "v1beta";
export const GEMINI_DEFAULT_FILE_MIME_TYPE = "application/octet-stream";
