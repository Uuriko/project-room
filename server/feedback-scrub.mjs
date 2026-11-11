// Repro privacy: redact secret-shaped material at intake, BEFORE dedup and
// storage. Production port of ~/workspace/feedback-endpoint/scrub.mjs.
// Raw auth material must never reach long-term storage, and model input is
// hash-only by construction.
//
// Rules are denylists over key names and value shapes. scrubValue() is
// recursive, never mutates its input, and returns a fresh structure.
// Coverage extends to free text, not just structured keys: URI userinfo
// passwords, Azure AccountKey values, PyPI/Docker/Discord token shapes,
// Basic/Bearer scheme credentials, secret-shaped assignments in prose,
// and credentials split across a line break.
// Scrubbing before dedupKey computation is deliberate: two agents filing the
// same bug with different tokens should cluster together (the error signature
// uses status + code only, so scrubbing does not cause false merges).

// Key names that always indicate credentials, regardless of value.
// account[_-]?key covers Azure storage connection strings (AccountKey=…),
// whose value is a full storage credential.
const SECRET_KEY_RE =
  /api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|auth(entication|orization)?|bearer|private[_-]?key|client[_-]?secret|session[_-]?id|access[_-]?key|refresh[_-]?token|account[_-]?key|signature|^sig$/i;

// JWT-shaped: three base64url segments. Global: a string can carry several
// secrets, and replace() without /g would redact only the first.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;

// PEM private key blocks.
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// Known vendor token prefixes, plus this product's own credential shapes
// (pri_ identity secrets, rak_ agent API keys, ga1. guest-agent tokens):
// the tokens a reporter here is most likely to paste are our own, and the
// intake contract above — raw auth material never reaches storage —
// covers them first, not last (#3602).
const TOKEN_PREFIX_RE = /\b(sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[bap]-|AKIA|AIza|glpat-|dckr_pat_|pri_|rak_|ga1\.)[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;

// PyPI upload tokens (pypi-…): the body can carry dot-separated segments,
// which the shared prefix class above would leave behind, so it gets its
// own pattern.
const PYPI_RE = /\bpypi-[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})*/g;

// Discord bot tokens: three dot-separated segments with a short (6-char)
// middle segment — distinct from a JWT, whose segments are all 8+ chars
// and whose header segment is longer than a Discord user-id segment.
const DISCORD_RE = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}(?![A-Za-z0-9_-])/g;

// A credential split across a line break: a known-prefix token at end of
// line whose continuation is a bare token-alphabet line. The prefix half
// alone matched TOKEN_PREFIX_RE and the unshaped second half survived
// verbatim; consume both halves together.
const SPLIT_TOKEN_RE = /\b(?:sk-|rk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[bap]-|AKIA|glpat-|pypi-|dckr_pat_|pri_|rak_|ga1\.)[A-Za-z0-9_-]{8,}\r?\n[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;

// Password inside a URI's userinfo (scheme://user:password@host), for any
// scheme: mongodb(+srv), postgres, mysql, redis, amqp, https, … The
// password is the run between the userinfo colon and the '@'; a URI with
// no password (user@host, host:port) does not match, because the colon
// must appear before any '@' or '/' and be followed by a non-empty run
// ending at '@'.
const URI_PASSWORD_RE = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\s/:@'"]+)?):([^\s/@'"]+)@/g;

// Authorization scheme credentials in free text: "Authorization: Basic
// <base64>" / "Bearer <token>". Runs after JWT_RE, so a Bearer JWT is
// already a placeholder and does not match the token class here.
const AUTH_SCHEME_RE = /\b(Authorization\s*:\s*(?:Basic|Bearer)\s+|Bearer\s+)[A-Za-z0-9+/=_-]{8,}(?![A-Za-z0-9+/=_-])/g;

// Free-text assignment of a secret-shaped key: key=value, key: value, or
// the JSON forms "key": "value". SECRET_KEY_RE only ever fired on
// structured object keys, so the same shapes in prose (observed/expected
// text, attempt bodies pasted as strings) reached storage verbatim —
// including prefixed/suffixed key names (my_password_value, passwordHash),
// which the key pattern matches as a substring of the key token.
// Guards against over-scrubbing ordinary prose: a bare ':' assignment is
// only redacted when the key or value is quoted (JSON-shaped) or the
// value is a token-length run (8+ chars); '=' assignments and quoted
// values are unambiguous and always redacted. Values that are already
// redaction placeholders are left alone.
const ASSIGNMENT_RE = /(^|[\s{,;])(["']?)([A-Za-z0-9_-]*?(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|auth(?:entication|orization)?|bearer|private[_-]?key|client[_-]?secret|session[_-]?id|access[_-]?key|refresh[_-]?token|account[_-]?key)[A-Za-z0-9_-]*)\2(\s*[:=]\s*)(["']?)([^\s"',;}\]]+)/gim;

function scrubAssignments(s) {
  return s.replace(ASSIGNMENT_RE, (m, pre, keyQuote, key, sep, valQuote, value) => {
    if (value.startsWith("[REDACTED")) return m;
    const unambiguous = sep.includes("=") || keyQuote !== "" || valQuote !== "";
    if (!unambiguous && value.length < 8) return m;
    return `${pre}${keyQuote}${key}${keyQuote}${sep}${valQuote}[REDACTED:credential]${valQuote}`;
  });
}

function scrubUriPasswords(s) {
  return s.replace(URI_PASSWORD_RE, (m, head, pw) =>
    pw.startsWith("[REDACTED") ? m : `${head}:[REDACTED:credential]@`);
}

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
  // Split-line credentials first: the continuation half must be consumed
  // together with its prefixed half, before the prefix rule can orphan it.
  out = out.replace(SPLIT_TOKEN_RE, "[REDACTED:token]");
  out = out.replace(JWT_RE, "[REDACTED:jwt]");
  out = scrubUriPasswords(out);
  out = out.replace(AUTH_SCHEME_RE, "$1[REDACTED:credential]");
  out = scrubQuerySecrets(out);
  // Token shapes before assignments: a known token used as an assignment
  // value keeps the [REDACTED:token] marker (the assignment rule's
  // placeholder guard then leaves it untouched).
  out = out.replace(PYPI_RE, "[REDACTED:token]");
  out = out.replace(TOKEN_PREFIX_RE, "[REDACTED:token]");
  out = out.replace(DISCORD_RE, "[REDACTED:token]");
  out = scrubAssignments(out);
  return out;
}

// Query-string secrets (H-3): redact the value of any query parameter whose
// name is secret-shaped (?api_key=, ?token=, ?secret=, ...). Vendor-prefix
// rules only catch prefixed tokens, so a bare ?api_key=deadbeef1 used to
// pass through to storage. Runs inside scrubString so every string surface
// (request paths, goals, observed/expected prose) is covered. Only the value
// is replaced; the parameter name and the rest of the URL survive.
function scrubQuerySecrets(s) {
  const q = s.indexOf("?");
  if (q === -1) return s;
  const hash = s.indexOf("#", q + 1);
  const end = hash === -1 ? s.length : hash;
  const query = s.slice(q + 1, end);
  if (!query.includes("=")) return s;
  const scrubbed = query.split("&").map(pair => {
    const eq = pair.indexOf("=");
    if (eq === -1) return pair;
    const rawName = pair.slice(0, eq);
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch { /* keep the raw name */ }
    return SECRET_KEY_RE.test(name) ? `${rawName}=[REDACTED:credential]` : pair;
  }).join("&");
  return s.slice(0, q + 1) + scrubbed + s.slice(end);
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
