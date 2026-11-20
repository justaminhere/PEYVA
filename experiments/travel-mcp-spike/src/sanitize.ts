/**
 * Redacts anything that could be a secret before raw responses are written to disk.
 * Provider responses here carry no account data (no login), but stderr and error
 * texts can contain proxy URLs with credentials.
 */
const SECRET_KEY = /token|cookie|session|^auth|password|secret|phone|mobile|email|national_?id/i;

export function redactText(s: string): string {
  return s
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1***:***@") // user:pass@ in URLs
    .replace(/\b(srt\.)[A-Za-z0-9+/=._-]+/g, "$1***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/g, "$1 ***");
}

export function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "***redacted***" : redactValue(val);
    return out;
  }
  return v;
}
