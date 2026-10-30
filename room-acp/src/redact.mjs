// Credential redaction for everything room-acp prints or posts.
const PATTERNS = [/\brak_[A-Za-z0-9_-]{8,}/g, /\bpri_[A-Za-z0-9_-]{8,}/g, /\brk_[A-Za-z0-9_-]{8,}/g, /\b[A-Z]{2}-[0-9A-Z]{16,40}\b/g, /(authorization:\s*bearer\s+)\S+/gi];
const secrets = new Set();

export function registerSecret(value) { if (typeof value === "string" && value.length >= 8) secrets.add(value); }
export function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  for (const pattern of PATTERNS) out = out.replace(pattern, (match, prefix) => (typeof prefix === "string" && /bearer/i.test(prefix) ? `${prefix}[redacted]` : "[redacted]"));
  return out;
}
export function logger(write = line => process.stderr.write(line + "\n")) {
  return (...parts) => write(redact(parts.join(" ")));
}
