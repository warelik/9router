// Claude thinking signature validation (ported from CLIProxyAPI internal/signature).
// E-form: single-layer base64, decoded[0] == 0x12 (Claude marker).
// C-form: single-layer base64, the same marker preceded by a protobuf field-1 varint (08 <version>), as in Claude 5.5.
// Double-layer (R…/Q…): base64 of the E-/C-form text; outer decodes to base64 text, inner carries the marker.
// Cache prefix "...#sig" stripped before validation.

const MAX_CLAUDE_SIGNATURE_LEN = 32 * 1024 * 1024;
const CLAUDE_SIGNATURE_MARKER = 0x12;

function stripCachePrefix(rawSignature) {
  const sig = typeof rawSignature === "string" ? rawSignature.trim() : "";
  if (!sig) return "";
  const idx = sig.indexOf("#");
  return idx >= 0 ? sig.slice(idx + 1).trim() : sig;
}

// Marker may be preceded by a protobuf field-1 varint (08 <version>), as in Claude 5.5 "C…" signatures.
function hasClaudeMarker(buf) {
  let i = 0;
  if (buf[0] === 0x08) {
    i = 1;
    while (i < buf.length && (buf[i] & 0x80)) i++;
    i++;
  }
  return i < buf.length && buf[i] === CLAUDE_SIGNATURE_MARKER;
}

export function hasClaudeSignaturePrefix(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  return sig.length > 0 && (sig[0] === "E" || sig[0] === "R");
}

function decodeBase64Strict(text) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  if (/[+/]/.test(text) && /[-_]/.test(text)) return null;
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(standard, "base64");
  const canonical = decoded.toString("base64");
  const expected = standard.includes("=") ? canonical : canonical.replace(/=+$/, "");
  return standard === expected ? decoded : null;
}

// Preserve the encoded provider value; remove only legacy cache metadata.
// Both encoding layers must be complete canonical padded or unpadded base64.
export function normalizeClaudeSignature(rawSignature) {
  if (typeof rawSignature !== "string" || rawSignature.length > MAX_CLAUDE_SIGNATURE_LEN) return null;
  const sig = stripCachePrefix(rawSignature);
  if (!sig) return null;

  try {
    const decoded = decodeBase64Strict(sig);
    if (!decoded?.length) return null;
    if (hasClaudeMarker(decoded)) return sig;
    const outerText = decoded.toString("latin1");
    const inner = decodeBase64Strict(outerText);
    return inner?.length > 0 && hasClaudeMarker(inner) ? sig : null;
  } catch {
    return null;
  }
}

export function isValidClaudeSignature(rawSignature) {
  return normalizeClaudeSignature(rawSignature) !== null;
}
