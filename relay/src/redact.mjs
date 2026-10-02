// Logs may include request metadata. Authorization and anything that looks
// like a Room bearer or a lease token is replaced before it reaches console.

const SENSITIVE_KEY = /authorization|bearer|token|secret|verifier|password|signature|jwk/i;
const BEARER_HEADER = /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}/gi;
const PREFIXED = /\b(?:pri_|rak_)[A-Za-z0-9_-]{8,}/g;

const recent = [];

export function redact(value, key = null) {
  if (typeof value === "string") {
    if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
    return value.replace(BEARER_HEADER, "Bearer [redacted]").replace(PREFIXED, "[redacted]");
  }
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [name, item] of Object.entries(value)) out[name] = redact(item, name);
    return out;
  }
  return value;
}

export function log(fields) {
  const line = JSON.stringify(redact(fields));
  recent.push(line);
  if (recent.length > 100) recent.shift();
  console.log(line);
}

export function recentLogs() {
  return [...recent];
}
