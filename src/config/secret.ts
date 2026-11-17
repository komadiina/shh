/**
 * Stored passwords (`password_b64`). Base64 only keeps passwords from being
 * readable at a glance; it is NOT encryption. The UI warns before storing one.
 */

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodePassword(password: string): string {
  return Buffer.from(password, "utf8").toString("base64");
}

/** Decode a stored password; returns undefined when the value is not valid base64 / UTF-8. */
export function decodePassword(encoded: string): string | undefined {
  const compact = encoded.replace(/\s+/g, "");
  if (!BASE64_RE.test(compact)) return undefined;
  const bytes = Buffer.from(compact, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
