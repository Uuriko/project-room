/**
 * bridge/lib/redact.mjs — secret redaction discipline (mirrors relay's redact.mjs).
 *
 * Two layers:
 *  1. redactValue: deep redaction by KEY name (/authorization|bearer|token|.../)
 *     plus VALUE-shape masking for secret-shaped strings at any depth.
 *  2. redactSecretShaped: masks secret-shaped values inside free text
 *     (pane output before it is returned to room code).
 *
 * F1W2-T6 cure: the pattern set is completed against the F1-Q4 adversarial
 * battery (19 shapes; bridge leaked 17/19 at e850efef). The headline defect
 * was PEM handling: only the -----BEGIN----- marker was stripped, leaving
 * the base64 key body in the output. PEM blocks are now consumed whole
 * (markers AND body), and the free-text path also handles the other
 * battery classes whose fix is the same pattern-set completion: vendor
 * token prefixes (glpat-, pypi-, dckr_pat_), Discord bot tokens, Basic
 * auth, URL userinfo passwords (mongodb/mysql/redis/amqp/...), credential
 * assignments in text form (client_secret JSON, PASSWORD=, my_password_value:,
 * passwordHash=, AccountKey=), and known-prefix tokens split across a
 * line break. Key names and separators are preserved in structured forms;
 * only the secret part is replaced.
 */
export const SENSITIVE_KEY = /authorization|bearer|token|secret|verifier|password|signature|jwk|cookie|apikey|api[_-]?key|credential|passphrase|private[_-]?key/i;
export const REDACTED = '[redacted]';

// PEM private-key blocks: BEGIN marker, any header lines, the base64 body
// (any line breaks, with or without a trailing newline) and the END marker
// are consumed as one match. An unterminated block (pane output truncated
// mid-key) fails closed: everything from the BEGIN marker to the next
// double quote or the end of the text is treated as key material.
// F1W2-T6b fixup: the label may end in PRIVATE KEY BLOCK as well as
// PRIVATE KEY (e.g. -----BEGIN PGP PRIVATE KEY BLOCK-----, the R6 recheck's
// named risk R1: that label variant escaped because the pattern required
// the dashes immediately after PRIVATE KEY). Non-private-key blocks
// (CERTIFICATE, PUBLIC KEY, ...) still do not match and are preserved.
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_UNTERMINATED_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?="|$)/g;
const PEM_MARKER_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

// A known-prefix token split across a line break: the shaped first line
// identifies the credential, so the continuation line(s) are part of the
// same match. (A bare continuation fragment with no shaped first line
// carries no shape and is out of scope — see the PR body's residuals.)
const SPLIT_TOKEN_RE = /(?:sk-|ghp_|gh[ousr]_|github_pat_|glpat-|pypi-|dckr_pat_|xox[bap]-|pri_|rak_|ga1\.)[A-Za-z0-9_-]{8,}(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9_-]{8,})+/g;

// URL userinfo: scheme://user:password@host — only the password is
// replaced; scheme, user and host stay readable. The scheme is
// length-bounded so the class cannot backtrack across long runs.
const URL_USERINFO_RE = /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]{0,256}:)([^\s/@]{1,})(@)/g;

// Credential assignments in free text: a key name containing a credential
// stem (prefixes/suffixes allowed, mirroring SENSITIVE_KEY's substring
// discipline: my_password_value, passwordHash, client_secret, AccountKey),
// then : or =, then a quoted value (consumed to the matching quote) or a
// bare token value. The key, separator and quotes are preserved.
const ASSIGNMENT_KEY_SRC = String.raw`[A-Za-z0-9_-]*?(?:passphrase|password|passwd|pwd|private[_-]?key|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|account[_-]?key|secret|token|credential)[A-Za-z0-9_-]*`;
const ASSIGNMENT_RE = new RegExp(
  `(${ASSIGNMENT_KEY_SRC})(["']?\\s*[:=]\\s*)(["'])((?:(?!\\3)[\\s\\S]){4,}?)\\3|(${ASSIGNMENT_KEY_SRC})(["']?\\s*[:=]\\s*["']?)([^\\s"',;}\\]<&]{4,})`,
  'gi',
);

const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /gh[ousr]_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[bap]-[A-Za-z0-9-]{8,}/g,
  /glpat-[A-Za-z0-9_-]{8,}/g,
  /pypi-[A-Za-z0-9._-]{8,}/g,
  /dckr_pat_[A-Za-z0-9_-]{8,}/g,
  /\bpri_[A-Za-z0-9_-]{8,}/g,
  /\brak_[A-Za-z0-9_-]{8,}/g,
  /\bga1\.[A-Za-z0-9_-]{16,}/g, // room guest-link credential
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}/g, // Discord bot token shape
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT-shaped
];

// Detection set for looksSecretShaped: the token shapes plus the
// structured forms (PEM, URL userinfo, assignments) whose presence makes
// a whole string value secret-bearing under redactValue.
const DETECT_RES = [...SECRET_SHAPES, PEM_BLOCK_RE, PEM_MARKER_RE, URL_USERINFO_RE, ASSIGNMENT_RE];

export function looksSecretShaped(s) {
  if (typeof s !== 'string') return false;
  return DETECT_RES.some((re) => { re.lastIndex = 0; return re.test(s); });
}

export function redactSecretShaped(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  // Structured forms first: their matches span (PEM bodies, split tokens)
  // or extend beyond (assignments, userinfo) what the token shapes see.
  out = out.replace(PEM_BLOCK_RE, REDACTED);
  out = out.replace(PEM_UNTERMINATED_RE, REDACTED);
  out = out.replace(SPLIT_TOKEN_RE, REDACTED);
  out = out.replace(URL_USERINFO_RE, (_m, prefix, _secret, at) => `${prefix}${REDACTED}${at}`);
  out = out.replace(ASSIGNMENT_RE, (m, qk, qs, quote, _qv, pk, ps, _pv) => {
    if (qk !== undefined) return `${qk}${qs}${quote}${REDACTED}${quote}`;
    if (pk !== undefined) return `${pk}${ps}${REDACTED}`;
    return m;
  });
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
