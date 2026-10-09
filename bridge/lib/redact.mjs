/**
 * bridge/lib/redact.mjs — secret redaction discipline (mirrors relay's redact.mjs).
 *
 * Two layers:
 *  1. redactValue: deep redaction by KEY name (/authorization|bearer|token|.../)
 *     plus VALUE-shape masking for secret-shaped strings at any depth.
 *  2. redactSecretShaped: masks secret-shaped values inside free text
 *     (pane output before it is returned to room code).
 */
export const SENSITIVE_KEY = /authorization|bearer|token|secret|verifier|password|signature|jwk|cookie/i;
export const REDACTED = '[redacted]';

const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /gh[ousr]_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[bap]-[A-Za-z0-9-]{8,}/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bpri_[A-Za-z0-9_-]{8,}/g,
  /\brak_[A-Za-z0-9_-]{8,}/g,
  /\bga1\.[A-Za-z0-9_-]{16,}/g, // room guest-link credential
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT-shaped
];

export function looksSecretShaped(s) {
  if (typeof s !== 'string') return false;
  return SECRET_SHAPES.some((re) => { re.lastIndex = 0; return re.test(s); });
}

export function redactSecretShaped(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of SECRET_SHAPES) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

export function redactValue(value, depth = 0) {
  if (depth > 12) return REDACTED;
  if (typeof value === 'string') {
    return looksSecretShaped(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}
