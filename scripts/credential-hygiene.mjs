// FIX-27: credential hygiene gate.
//
// Two defenses for credential-shaped files in the tree:
//
//  1. `.gitignore` (see GITIGNORE_CREDENTIAL_PATTERNS) keeps agent identities
//     (`identity.json`), private keys (`*.pem`, `*.key`, ...), credential
//     dumps and token data files out of git from commit zero. The patterns
//     are deliberately narrow: code/test files with "token"/"secret" in the
//     name (token-bucket.mjs, secret-scan.mjs, design-tokens-baseline.json)
//     must never match.
//  2. This scanner fails CI if a credential-shaped file is already tracked
//     (or sitting un-ignored in the working tree), and sniffs checked-in
//     code for Bearer-token literals — including the JSON `"bearer": "..."`
//     form the provider-prefix secret scanners do not cover.
//
// Usage: node scripts/credential-hygiene.mjs        # scan the live tree
// Exit 0: clean. Exit 1: findings (blocks the PR).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Canonical .gitignore lines for credential-shaped paths. The hygiene test
// pins these so the "gitignored from commit zero" norm cannot drift.
export const GITIGNORE_CREDENTIAL_PATTERNS = [
  "identity.json",
  "identity-*.json",
  "*-identity.json",
  "*credential*.json",
  "*credential*.txt",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.token",
  "token.json",
  "token.txt",
  "*-token.json",
  "*-token.txt",
  "*_token.json",
  "*_token.txt",
];

// Filename rules. Basename-based, case-insensitive. Order matters only for
// the reported rule id; the first match wins.
export const FILENAME_RULES = [
  {
    id: "identity-json",
    test: (b) => /^identity\.json$/i.test(b) || /^identity[-_].*\.json$/i.test(b) || /^.*[-_]identity\.json$/i.test(b),
  },
  {
    id: "credential-json",
    test: (b) => /credential/i.test(b) && /\.(json|txt)$/i.test(b),
  },
  {
    id: "private-key-file",
    test: (b) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(b),
  },
  {
    id: "token-file",
    test: (b) =>
      /\.token$/i.test(b) ||
      /(^|[-_])tokens?\.(txt|json|ya?ml)$/i.test(b) ||
      /^(access|id|refresh|auth|bearer)[_-]?tokens?\.(txt|json|ya?ml)$/i.test(b) ||
      /^(access|id|refresh|auth|bearer)[_-]?tokens?$/i.test(b),
  },
];

// Explicit exemptions: repo-root-relative paths that are legitimately
// tracked despite matching a rule. Starts empty — the tree is clean; every
// future entry needs a reason in a code comment next to it.
export const HYGIENE_ALLOWLIST = new Set([
  // (no active entries)
]);

// Line-level exemptions for known-safe fixtures. Each entry names the file
// (repo-root-relative), a substring that must appear on the finding's line,
// and the reason. Prefer this over path exemptions: the substring keeps the
// exemption working when lines move, and a stale entry simply stops matching
// (fail-closed — the gate flags the line again until the entry is fixed).
export const LINE_ALLOWLIST = [
  {
    file: "tests/job-heartbeat.test.js",
    match: "redactError(",
    // redactError unit test: deliberate fake pri_/ghp_ fixtures on the
    // "Bearer ..." line, asserted to be redacted by the test itself.
    reason: "known-safe redaction fixture",
  },
];

function lineExempted(rel, lineText) {
  return LINE_ALLOWLIST.some((e) => e.file === rel && lineText.includes(e.match));
}

export function matchFilenameRule(filePath) {
  const base = path.basename(filePath);
  for (const rule of FILENAME_RULES) {
    if (rule.test(base)) return rule.id;
  }
  return null;
}

// Bearer-token literal sniff. Catches both the HTTP-auth form
// ("Bearer <token>") and the JSON config form ("bearer": "<token>").
// Placeholder-looking values (example/fake/redacted/<...>) never count.
const BEARER_AUTH_RE = /\bbearer\s+([A-Za-z0-9\-_.~+/]{20,}=*)/i;
const BEARER_JSON_RE = /"bearer"\s*:\s*"([A-Za-z0-9\-_.~+/=]{16,})"/i;
const PLACEHOLDER_RE = /(example|placeholder|fake|dummy|sample|changeme|todo|xxx|<[^>]*>|\*{4,}|redacted)/i;

export function redactPreview(line, token) {
  return line.replace(token, "***");
}

export function sniffBearerLiterals(lines) {
  const findings = [];
  lines.forEach((line, i) => {
    const m = line.match(BEARER_AUTH_RE) || line.match(BEARER_JSON_RE);
    if (m && !PLACEHOLDER_RE.test(m[1])) {
      findings.push({
        line: i + 1,
        rule: "bearer-token-literal",
        preview: redactPreview(line, m[1]).slice(0, 160),
      });
    }
  });
  return findings;
}

const MAX_SNIFF_BYTES = 512 * 1024;

function isTextFile(absPath) {
  try {
    if (statSync(absPath).size > MAX_SNIFF_BYTES) return false;
    const head = readFileSync(absPath);
    return !head.subarray(0, 8192).includes(0); // no NUL bytes
  } catch {
    return false;
  }
}

// Scan an explicit list of files (absolute or repo-relative). Returns
// [{ file (repo-relative), line (null for filename findings), rule, preview }].
export function scanCredentialHygiene(files, { root } = {}) {
  const repoRoot = root ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const findings = [];
  const seen = new Set();
  for (const f of files) {
    const abs = path.resolve(repoRoot, f);
    const rel = path.relative(repoRoot, abs).replaceAll(path.sep, "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (HYGIENE_ALLOWLIST.has(rel)) continue;
    const filenameRule = matchFilenameRule(rel);
    if (filenameRule) {
      findings.push({ file: rel, line: null, rule: filenameRule, preview: rel });
    }
    if (isTextFile(abs)) {
      const lines = readFileSync(abs, "utf8").split("\n");
      for (const hit of sniffBearerLiterals(lines)) {
        if (lineExempted(rel, lines[hit.line - 1])) continue;
        findings.push({ file: rel, line: hit.line, rule: hit.rule, preview: hit.preview });
      }
    }
  }
  return findings;
}

// The hygiene surface: everything `git add -A` would stage — tracked files
// plus untracked files that .gitignore does not exclude.
export function listHygieneFiles(root) {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const findings = scanCredentialHygiene(listHygieneFiles(root), { root });
  for (const f of findings) {
    console.log(`${f.file}:${f.line ?? "-"} [${f.rule}] ${f.preview}`);
  }
  if (findings.length > 0) {
    console.error(`credential-hygiene: ${findings.length} finding(s) — remove the files, never commit secrets`);
    process.exit(1);
  }
  console.log("credential-hygiene: clean");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
