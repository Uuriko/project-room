// Secret-scan CI gate (H005 wiring). Scans the repo tree for accidentally
// committed secrets using server/secret-scan.mjs. Fails the build on any
// finding. Pure, dependency-free; runs in the contract job via check.mjs.
//
// The config (ALLOWLIST, SKIP_FILES, ...) is exported so the PR diff gate
// (scripts/secret-scan-diff.mjs) and its tests reuse the exact same rules.
// The tree walk below only runs when this file is executed directly.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "../server/secret-scan.mjs";

// Directories never scanned (vendored code, build output, local scratch).
export const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "test-results", "runlogs-tmp", "dist"]);
// File extensions worth scanning. Secrets live in text; skip binaries/images.
export const SCAN_EXT = /\.(mjs|js|cjs|json|yaml|yml|toml|md|txt|html|css|env|example|sh)$/i;
// File paths never scanned (lockfiles carry hashes, not secrets).
// Fixture/check scripts and READMEs use placeholder secrets (verified 2026-09-16).
// Pinned, reproducibly bundled sanitize-html dependencies contain HTML entity tables,
// base64 alphabets and parser messages, not credentials (build-gmail-sanitizer.mjs).
export const SKIP_FILES = [/server\/vendor\/gmail-html-sanitizer\.mjs$/, /package-lock\.json$/, /pnpm-lock\.yaml$/, /\.min\.js$/, /secret-scan-check\.mjs$/,
  /-fixture\.mjs$/, /-check\.mjs$/, /README\.md$/];
// Known-safe lines: the scanner's own patterns, documented examples, redacted placeholders,
// and variable assignments (not hardcoded values).
export const ALLOWLIST = [
  // The scanner's own documented patterns (server/secret-scan.mjs): match the
  // literal regex text (`AKIA[0-9A-Z]{16}` etc.) only. A looser entry here
  // would match real secret-shaped values too and silently disable the
  // aws-access-key / github-token / slack-token rules on every scanned line.
  /AKIA\[0-9A-Z\]\{16\}/, // scanner's own AWS pattern doc (server/secret-scan.mjs)
  /gh\[op\]_\[A-Za-z0-9\]\{36\}/, // scanner's own GitHub pattern doc
  /xox\[baprs\]-\[A-Za-z0-9-\]\+/, // scanner's own Slack pattern doc
  /<redacted>/i, // explicit redaction marker
  /DASHA_API_KEY=<redacted>/, // documented placeholder (scripts/dasha-bridge.mjs)
  /example\.com/, // documentation URLs
  // Variable/function/member references, not hardcoded secrets:
  // `secret = generateSecret()`, `token: getToken()`, `token: f.keys.producer`,
  // `token: f.keys[actor]`, `token = store.issueAccessKey('x', y)`, `password = foo`
  /\b(secret|password|passwd|pwd|token|api[_-]?key)\b\s*[:=]\s*[a-zA-Z_$][\w$]*(\s*(\.\s*[a-zA-Z_$][\w$]*|\[[^\]]+\]))*(\s*\([^)]*\))?\s*([,;)\]}]|$)/i,
  /\b(secret|password|passwd|pwd|token|api[_-]?key)\b\s*[:=]\s*["'][^"']{0,11}["']/, // short placeholders
  // Template literals assembled at runtime: `token = `${a}.${b}``. Allowed only
  // when every character outside an interpolation is a separator, so a literal
  // run long enough to be a credential is still caught.
  /\b(secret|password|passwd|pwd|token|api[_-]?key)\b\s*[:=]\s*`(?:\$\{[^{}`]*\}|[\s.\-_:/+,;=&?#|])*`/i,
  // Verified false positives (2026-09-16 audit):
  /IDENTITY_SECRET_PREFIX/, // runtime-generated: `secret = PREFIX + base64url(randomBytes(32))`
  /CODE_ALPHABET\s*=\s*"/, // invite-code alphabet constants, not secrets
  /LEGACY_CODE_ALPHABET\s*=\s*"/, // invite-code alphabet constants, not secrets
  /SHARE_CODE_ALPHABET\s*=\s*"/, // Crockford 9-char human join-code alphabet demo, not a credential
  /token:\s*"TELEGRAM_BOT_TOKEN"/, // env var NAME as string, not a token value
  /password:\s*form\.querySelector/, // src/auth-signin-ui.js: reads the user's typed password back from the DOM to preserve it across signup/login mode toggles — not a hardcoded secret
  /secret = \(data\.secret \|\| ""\)\.trim\(\)/, // src/agent-signin-ui.js: reads the user's typed identity secret back from the sign-in form's FormData — runtime input, not a hardcoded secret
  /webhookSecret:\s*"TELEGRAM_WEBHOOK_SECRET"/, // env var NAME as string
  /insertCredential\(/, // `token = this.insertCredential(...)` — credential store API
  /base64url\(randomBytes\(/, // runtime-generated random values
  /generateSecret\(\)/, // runtime-generated secrets in fixtures
  /secret = stashed\?\.secret/, // src/app.js: reads the stashed access-request identity secret back from sessionStorage — variable reference, not a hardcoded secret
  /secret = minted\?\.secret/, // src/app.js: reads the freshly minted access-request identity secret — variable reference, not a hardcoded secret
  /process\.env\.[A-Z_]+/, // env var NAMES (not values)
  /^\|.*\|$/, // markdown table rows
  /randomBytes\(/, // runtime-generated: `randomBytes(32).toString("base64url")`
  /\btokens\.get\(/, // `token = tokens.get(tokenId)` — Map lookup, not a secret
  /BASE32_ALPHABET\s*=/, // TOTP alphabet constant
  /GSM7_BASIC\s*=\s*"/, // GSM-7 SMS alphabet constant (server/sms-outbound.mjs) — character set for segmentation accounting, not a secret
  /github\.com\/Uuriko\/[A-Za-z0-9_.-]+\/(pull|issues)\/\d+/, // repo PR/issue URLs (evidence links)
  /\/blob\/main\/docs\//, // docs URLs in discovery configs
  /^\s*secret:\s*<redacted>\s*$/, // literally redacted values
  /\$SCRIPT_DIR/, // shell script variable references
  /^\s*cp\s+"/, // shell copy commands
  /inviteSecretFromText\(/, // `secret = inviteSecretFromText(...)` — clipboard extraction
  /can store a secret:/, // documentation template string
  /tokenPattern\.test\(/, // `token: tokenPattern.test(...) ? ...` — validation, not a secret
  /\.replace\(.*\.toUpperCase\(\)/, // `secret.replace(...).toUpperCase()` — transform, not a secret
  /DUMMY_PASSWORD_VERIFIER/, // slice 2: public placeholder scrypt verifier (hash of a known
    // placeholder password); used only so unknown-email logins cost one scrypt
    // derivation. Not a credential — it is deliberately published in source.
  /AGENT_CARD_PUBLIC_KEY = "e74i9XPv8I1hIhTsVztVupDr6moyCfL\+nGr1HDoOpTc="/, // Owner recovery 2026-09-24: room Agent Card
    // signing PUBLIC key — intentionally committed and published inside the card itself.
    // The private Ed25519 seed is never in the repo (deploy host key file / env only).
  /"sha(?:Full|Url)?":\s*"([0-9a-f]{40}|https:\/\/github\.com\/Uuriko\/project-room\/commit\/[0-9a-f]{40})"/, // receipts-data.mjs: git merge-commit SHAs from public
    // upstream history (verified via `gh api`), not secrets — 40-char hex is the git SHA-1 shape.
];

// Directories scanned: source code where a real secret could hide.
// research/ and docs/ are prose with quoted examples; tests/ use fixtures.
export const SCAN_DIRS = ["server", "src", "scripts", "client", "cloudflare", "deploy", "lanes", "specs"];
export const SCAN_ROOT_FILES = true; // *.mjs in repo root (server.mjs etc.)

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (SCAN_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const root = new URL("..", import.meta.url).pathname;

function runTreeScan() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    try { files.push(...walk(join(root, dir))); } catch { /* dir may not exist */ }
  }
  if (SCAN_ROOT_FILES) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && SCAN_EXT.test(entry.name)) files.push(join(root, entry.name));
    }
  }
  const filtered = files.filter(f => {
    if (SKIP_FILES.some(re => re.test(f))) return false;
    // Skip this gate's own allowlist doc lines by scanning everything anyway;
    // the ALLOWLIST above handles known-safe matches.
    try { return statSync(f).size <= 2 * 1024 * 1024; } catch { return false; }
  });

  let total = 0;
  for (const file of filtered) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const findings = scanText(text, { allowlist: ALLOWLIST });
    for (const f of findings) {
      console.error(`secret-scan: ${relative(root, file)}:${f.line} [${f.rule}] ${f.label} (${f.preview})`);
      total++;
    }
  }

  if (total > 0) {
    console.error(`\nsecret-scan: FAIL — ${total} finding(s). Remove the secret or add an allowlist entry with justification.`);
    process.exit(1);
  }
  console.log(`secret-scan: ok — ${files.length} files scanned, no findings.`);
}

// Only run the tree scan when executed directly (check.mjs spawns this
// file); importing it (diff gate, tests) gets the config without side
// effects.
const invokedAsCli =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  (process.argv[1] ?? "").endsWith("/secret-scan-check.mjs") ||
  (process.argv[1] ?? "").endsWith("\\secret-scan-check.mjs");
if (invokedAsCli) runTreeScan();
