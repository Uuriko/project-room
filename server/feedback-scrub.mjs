// Repro privacy: redact secret-shaped material at intake, BEFORE dedup and
// storage. Production port of ~/workspace/feedback-endpoint/scrub.mjs.
// Raw auth material must never reach long-term storage, and model input is
// hash-only by construction.
//
// Rules are denylists over key names and value shapes. scrubValue() is
// recursive, never mutates its input, and returns a fresh structure.
// Scrubbing before dedupKey computation is deliberate: two agents filing the
// same bug with different tokens should cluster together (the error signature
// uses status + code only, so scrubbing does not cause false merges).

// Key names that always indicate credentials, regardless of value.
const SECRET_KEY_RE =
  /api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|auth(entication|orization)?|bearer|private[_-]?key|client[_-]?secret|session[_-]?id|access[_-]?key|refresh[_-]?token/i;

// JWT-shaped: three base64url segments.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

// PEM private key blocks.
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/;

// Known vendor token prefixes.
const TOKEN_PREFIX_RE = /\b(sk-|rk-|ghp_|gho_|ghu_|ghs_|xox[bap]-|AKIA|glpat-)[A-Za-z0-9_-]{8,}\b/;

// Whole-value high-entropy blob (a bare token pasted as the entire value).
// 40+ chars of token alphabet. Deliberately does NOT match structured error
// codes ("invalid_claim_input" is short and has no 40-char run) or UUIDs
// with dashes (dashes break the class)... note: a 40-char hex run WOULD
// match — acceptable: a bare 40-char hex blob in a repro is far more likely
// a token than load-bearing debugging evidence, and the error signature
// (status + code) survives scrubbing.
const LONG_BLOB_RE = /^[A-Za-z0-9_+/=]{40,}$/;

export function scrubString(s) {
  if (typeof s !== "string") return s;
  let out = s.replace(PEM_RE, "[REDACTED:private-key]");
  out = out.replace(JWT_RE, "[REDACTED:jwt]");
  out = out.replace(TOKEN_PREFIX_RE, "[REDACTED:token]");
  return out;
}

export function scrubValue(value, keyName = "") {
  if (typeof value === "string") {
    if (SECRET_KEY_RE.test(keyName)) return "[REDACTED:credential]";
    if (LONG_BLOB_RE.test(value)) return "[REDACTED:blob]";
    return scrubString(value);
  }
  if (Array.isArray(value)) return value.map(v => scrubValue(v, keyName));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, k);
    return out;
  }
  return value;
}

// Scrub a full attempt (goal + request + response) for storage.
// Request/response paths are scrubbed as strings: tokens hide in query
// params (e.g. /api/things?api_key=sk-...).
export function scrubAttempt(attempt) {
  return {
    goal: scrubString(attempt.goal),
    request: scrubValue({ ...attempt.request, path: scrubString(attempt.request.path) }),
    response: scrubValue(attempt.response),
  };
}
