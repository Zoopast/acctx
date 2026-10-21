const SECRET_KEY = /token|secret|key|password|credential/i;
// Anything that looks like an opaque credential: long base64url/hex runs.
const LONG_OPAQUE = /[A-Za-z0-9_-]{32,}/g;

export function redact(input: string): string {
  return input
    .replace(/("?)([A-Za-z0-9_]*(?:token|secret|key|password)[A-Za-z0-9_]*)("?\s*[:=]\s*)("?)([^",\s}]+)/gi,
      (_m, q1, k, sep, q2) => `${q1}${k}${sep}${q2}<redacted>`)
    .replace(LONG_OPAQUE, "<redacted>");
}

/** Redact every string leaf in a JSON-like value whose key looks secret. */
export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "<redacted>" : redactObject(v);
    }
    return out;
  }
  if (typeof value === "string") return redact(value);
  return value;
}
