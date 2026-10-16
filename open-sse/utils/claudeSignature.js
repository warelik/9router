// Claude thinking signature validation (ported from CLIProxyAPI internal/signature).
// E-form: single-layer base64, decoded[0] == 0x12 (Claude marker).
// C-form: single-layer base64, the same marker preceded by a protobuf field-1 varint (08 <version>), as in Claude 5.5.
// Double-layer (R…/Q…): base64 of the E-/C-form text; outer decodes to base64 text, inner carries the marker.
// Cache prefix "...#sig" stripped before validation.

const MAX_CLAUDE_SIGNATURE_LEN = 32 * 1024 * 1024;
const CLAUDE_SIGNATURE_MARKER = 0x12;

function stripCachePrefix(rawSignature) {
  const sig = (rawSignature || "").trim();
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

// Strict-ish: validates base64 layers + Claude marker byte.
export function isValidClaudeSignature(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  if (!sig || sig.length > MAX_CLAUDE_SIGNATURE_LEN) return false;

  try {
    const decoded = Buffer.from(sig, "base64");
    if (!decoded.length) return false;
    if (hasClaudeMarker(decoded)) return true;
    const outerText = decoded.toString("latin1");
    if (!/^[A-Za-z0-9+/]+=*$/.test(outerText)) return false;
    const inner = Buffer.from(outerText, "base64");
    return inner.length > 0 && hasClaudeMarker(inner);
  } catch {
    return false;
  }
}
