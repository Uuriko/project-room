// Secret scanning (H005). A pure secret detector for text: pattern rules
// (API keys, tokens, private keys, common credential assignments) plus a
// Shannon-entropy check for high-entropy strings that look like secrets.
// scanText() returns findings with line numbers; scanLines() is the same
// over a pre-split array. An allowlist of regexes suppresses known-safe
// matches (test fixtures, documentation examples). Findings never include
// the secret value itself — only a redacted preview. Pure,
// dependency-free, deterministic; frozen outputs. CI/pre-commit wiring is
// a later slice.
const PATTERNS = [
  { id: "aws-access-key", label: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "aws-secret-key", label: "AWS secret key", regex: /\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*["']?[^"'\s]{20,}["']?/i },
  { id: "github-token", label: "GitHub token", regex: /\bgh[op]_[A-Za-z0-9]{36,}\b/ },
  { id: "generic-api-key", label: "API key assignment", regex: /\b(api[_-]?key|apikey)\b\s*[:=]\s*["']?[A-Za-z0-9\-_]{20,}["']?/i },
  { id: "generic-secret", label: "secret assignment", regex: /\b(secret|password|passwd|pwd|token)\b\s*[:=]\s*["']?[^"'\s]{12,}["']?/i },
  { id: "private-key", label: "private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "bearer-token", label: "bearer token", regex: /\bbearer\s+[A-Za-z0-9\-_.~+/]{20,}=*/i },
  { id: "slack-token", label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-key", label: "Stripe key", regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  // Regression rule for secret-scanning alert #1 (2026-09-17): a real
  // Telegram bot token was committed in tests/telegram-connect.test.js.
  // BotFather tokens are <bot-id>:<secret>; the burned one was 9 digits
  // plus a 34-char secret, so the shape accepts 34–35 char secrets.
  { id: "telegram-bot-token", label: "Telegram bot token", regex: /\b(?:bot)?\d{8,10}:[A-Za-z0-9_-]{34,35}(?![A-Za-z0-9_-])/ },
  // Wallet seed phrases: 12-24 lowercase words with explicit seed/mnemonic/
  // recovery context, quoted (unquoted prose in docs stays quiet). The
  // telegram_bot_token class of incident applies here too — a committed
  // mnemonic is a drained wallet.
  { id: "wallet-seed", label: "wallet seed phrase", regex: /\b(?:seed[_-]?phrase|mnemonic|recovery[_-]?phrase)\b["']?\s*[:=]\s*["']([a-z]+(?:\s+[a-z]+){11,23})["']/i },
];
const ENTROPY_THRESHOLD = 4.5, ENTROPY_MIN_LENGTH = 24;
class SecretScanError extends Error { constructor(code, message) { super(message); this.name = "SecretScanError"; this.code = code; } }
const fail = (code, message) => { throw new SecretScanError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_secret_scan", message); };

const entropyOf = value => {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
};
const redact = value => value.length <= 8 ? "****" : `${value.slice(0, 2)}…${value.slice(-2)}`;
// Match spans of a regex over one line. The regex is recompiled with the
// global flag on a fresh object so a caller-supplied stateful regex (stale
// lastIndex) can neither skip matches nor loop forever on empty matches.
function matchSpans(line, regex) {
  const spans = [];
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let m;
  while ((m = re.exec(line)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return spans;
}

// Per-finding allowlist (H-19): a finding is suppressed only when an
// allowlist match overlaps the finding's own span. The old whole-line check
// let one allowlisted token (a docs URL, a variable reference, an
// interpolation) silence a real secret sharing the line — the common
// URL-with-credentials / connection-string shape.
const findingAllowed = (allowlist, line, start, end) =>
  (allowlist ?? []).some(regex =>
    matchSpans(line, regex).some(([a, b]) => a < end && start < b));
// Scan text for secrets. allowlist is an array of RegExp; a finding is
// suppressed only when an allowlist match overlaps that finding's span.
export function scanText(text, { allowlist, safeEntropyTokens } = {}) {
  check(typeof text === "string" && text.length <= 10 * 1024 * 1024, "text must be a string up to 10 MiB");
  check(allowlist === undefined || (Array.isArray(allowlist) && allowlist.every(r => r instanceof RegExp)),
    "allowlist must be an array of RegExp");
  const lines = text.split("\n");
  return scanLines(lines, { allowlist, safeEntropyTokens });
}
export function scanLines(lines, { allowlist, safeEntropyTokens } = {}) {
  check(Array.isArray(lines) && lines.length <= 200000, "lines must be an array of at most 200000");
  check(allowlist === undefined || (Array.isArray(allowlist) && allowlist.every(r => r instanceof RegExp)),
    "allowlist must be an array of RegExp");
  check(safeEntropyTokens === undefined || (Array.isArray(safeEntropyTokens) && safeEntropyTokens.every(value => typeof value === "string")),
    "safeEntropyTokens must be an array of exact strings");
  const safeTokens = new Set(safeEntropyTokens ?? []);
  const findings = [];
  // Same tokenization as before (split on whitespace/quotes/brackets), but
  // with offsets so the allowlist can be evaluated per token.
  const tokenRe = /[^\s"'`,;()[\]{}]+/g;
  lines.forEach((line, index) => {
    check(typeof line === "string", `line ${index} must be a string`);
    const lineNo = index + 1;
    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(line);
      if (match) {
        const start = match.index, end = start + match[0].length;
        if (!findingAllowed(allowlist, line, start, end)) {
          findings.push(Object.freeze({ line: lineNo, rule: pattern.id, label: pattern.label,
            preview: redact(match[0]) }));
        }
      }
    }
    let tm;
    tokenRe.lastIndex = 0;
    while ((tm = tokenRe.exec(line)) !== null) {
      const token = tm[0];
      if (findings.some(f => f.line === lineNo)) break; // at most one high-entropy finding per line
      if (safeTokens.has(token) || token.length < ENTROPY_MIN_LENGTH || entropyOf(token) < ENTROPY_THRESHOLD) continue;
      const start = tm.index, end = start + token.length;
      if (findingAllowed(allowlist, line, start, end)) continue;
      findings.push(Object.freeze({ line: lineNo, rule: "high-entropy", label: "high-entropy string",
        preview: redact(token) }));
      break;
    }
  });
  return Object.freeze(findings);
}
export { SecretScanError, PATTERNS };
