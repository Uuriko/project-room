// Credential redaction for everything room-acp prints or posts.
//
// F1W2-T4 cure: the pattern set below brings this redactor up to the
// fleet pattern set the server scrubbers already catch (token prefixes,
// URI passwords, assignment-form secrets including prefixed/suffixed
// key names, PEM bodies, spaced passwords, provider key shapes). Before
// this cure the patterns covered only rak_/pri_/rk_ tokens, a
// two-letter-dash shape and Bearer headers, so the F1-Q4 adversarial
// battery leaked 19/19 shapes through this module, the ghp_ control
// included. Caller-registered secrets are still substituted first and
// every replacement is still "[redacted]".
const secrets = new Set();

export function registerSecret(value) { if (typeof value === "string" && value.length >= 8) secrets.add(value); }

// PEM blocks first: the whole block is the secret, body included. The
// second pattern fails closed on a truncated block with no END marker.
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_TRUNCATED_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g;

// A credential split across a line break: a prefixed token at end of
// line plus its bare continuation on the next line are one secret. The
// break may be a real newline or an escaped \n inside JSON text.
const SPLIT_TOKEN_RE = /(?:ghp_|gho_|ghu_|ghs_|ghr_|glpat-|pypi-|dckr_pat_|pri_|rak_|ga1\.)[A-Za-z0-9_-]{8,}(?:[ \t]*(?:\\[rn]|\r?\n)[ \t]*[A-Za-z0-9_-]{6,})+/g;

const AUTH_HEADER_RE = /(authorization["']?\s*:\s*["']?(?:bearer|basic)\s+)\S+/gi;
const COOKIE_HEADER_RE = /\b(Set-Cookie|Cookie)(["']?\s*:\s*["']?)[^\r\n"]+/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

// URL userinfo (mongodb://user:pass@host, redis://:pass@host, any
// scheme://user:pass@host): only the password between ":" and "@" goes;
// scheme, user and host stay readable.
const URL_USERINFO_RE = /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]{0,256}:)[^\s/@]{1,}(@)/g;

// Credential assignments. The key name may carry a prefix or suffix
// around the sensitive core (my_password_value, passwordHash,
// AccountKey=...), which is exactly what defeated boundary-anchored
// patterns. Quoted values are consumed to the matching quote; unquoted
// values may be spaced ("password=correct horse battery staple") and
// end at a , ; " ' } ] < & delimiter or a newline.
const ASSIGNMENT_KEY = String.raw`[A-Za-z0-9_.-]*?(?:pass(?:word|wd|phrase)?|secret|token|credential|api[_-]?key|apikey|account[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|session|signature|verifier|cookie|jwk|sid)[A-Za-z0-9_.-]*`;
const ASSIGNMENT_QUOTED_RE = new RegExp(String.raw`(${ASSIGNMENT_KEY})(["']?\s*[:=]\s*)(["'])((?:(?!\3)[\s\S]){1,}?)\3`, "gi");
const ASSIGNMENT_PLAIN_RE = new RegExp(String.raw`(${ASSIGNMENT_KEY})(["']?\s*[:=]\s*["']?)([^\s"',;}\]<&]+(?: [^\s"',;}\]<&]+)*)`, "gi");

const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,})?\b/g;
// Discord-style bot tokens: three dot-separated segments that are not JWTs.
const BOT_TOKEN_RE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g;
const TELEGRAM_RE = /\b\d{5,}:[A-Za-z0-9_-]{30,}/g;
const PREFIXED = /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|pypi-|dckr_pat_|xox[baprs]-|sk-ant-|sk-proj-|sk-svcacct-|rk_(?:live|test)_|sk_(?:live|test)_|pri_|rak_|rk_|ga1\.|npm_|hvs\.|SG\.)[A-Za-z0-9_-]{8,}/g;
const OPENAI_LEGACY_RE = /\bsk-[A-Za-z0-9]{20,}/g;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const ROOM_CODE_RE = /\b[A-Z]{2}-[0-9A-Z]{16,40}\b/g;

export function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  out = out.replace(PEM_RE, "[redacted]");
  out = out.replace(PEM_TRUNCATED_RE, "[redacted]");
  out = out.replace(SPLIT_TOKEN_RE, "[redacted]");
  out = out.replace(AUTH_HEADER_RE, (_match, prefix) => `${prefix}[redacted]`);
  out = out.replace(COOKIE_HEADER_RE, (_match, name, separator) => `${name}${separator}[redacted]`);
  out = out.replace(AUTH_SCHEME_RE, (_match, scheme, separator) => `${scheme}${separator}[redacted]`);
  out = out.replace(URL_USERINFO_RE, (_match, prefix, _secret, at) => `${prefix}[redacted]${at}`);
  out = out.replace(ASSIGNMENT_QUOTED_RE, (_match, key, separator, quote) => `${key}${separator}${quote}[redacted]${quote}`);
  out = out.replace(ASSIGNMENT_PLAIN_RE, (_match, key, separator) => `${key}${separator}[redacted]`);
  out = out.replace(JWT_RE, "[redacted]");
  out = out.replace(BOT_TOKEN_RE, "[redacted]");
  out = out.replace(TELEGRAM_RE, "[redacted]");
  out = out.replace(PREFIXED, "[redacted]");
  out = out.replace(OPENAI_LEGACY_RE, "[redacted]");
  out = out.replace(AWS_KEY_RE, "[redacted]");
  out = out.replace(ROOM_CODE_RE, "[redacted]");
  return out;
}
export function logger(write = line => process.stderr.write(line + "\n")) {
  return (...parts) => write(redact(parts.join(" ")));
}
