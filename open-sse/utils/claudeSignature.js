// Claude thinking signature validation (ported from CLIProxyAPI internal/signature).
// E-form: single-layer base64, decoded[0] == 0x12 (Claude marker).
// C-form: single-layer base64, the same marker preceded by a protobuf field-1 varint (08 <version>), as in Claude 5.5.
// Double-layer (R…/Q…): base64 of the E-/C-form text; outer decodes to base64 text, inner carries the marker.
// The decoded bytes of every form must also be one complete protobuf message.
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

function readVarint(buf, i) {
  let value = 0n;
  for (let shift = 0n; shift < 70n && i < buf.length; shift += 7n) {
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) return { value, next: i };
  }
  return null;
}

// A Claude signature is one protobuf message: every byte belongs to a field
// with a valid tag and wire type, and length-delimited fields end inside the
// buffer. The marker test alone only looks at the leading bytes; another
// provider's opaque signature passes it whenever its own first byte happens
// to be 0x12, and Anthropic then rejects the forwarded block.
function isCompleteProtobufMessage(buf) {
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag || tag.value >> 3n === 0n) return false;
    i = tag.next;
    switch (Number(tag.value & 7n)) {
      case 0: {
        const v = readVarint(buf, i);
        if (!v) return false;
        i = v.next;
        break;
      }
      case 1:
        i += 8;
        break;
      case 2: {
        const len = readVarint(buf, i);
        if (!len || len.value > BigInt(buf.length - len.next)) return false;
        i = len.next + Number(len.value);
        break;
      }
      case 5:
        i += 4;
        break;
      default:
        return false;
    }
    if (i > buf.length) return false;
  }
  return true;
}

function isClaudeSignatureBytes(buf) {
  return buf?.length > 0 && hasClaudeMarker(buf) && isCompleteProtobufMessage(buf);
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
    if (isClaudeSignatureBytes(decoded)) return sig;
    const outerText = decoded.toString("latin1");
    const inner = decodeBase64Strict(outerText);
    return isClaudeSignatureBytes(inner) ? sig : null;
  } catch {
    return null;
  }
}

export function isValidClaudeSignature(rawSignature) {
  return normalizeClaudeSignature(rawSignature) !== null;
}
