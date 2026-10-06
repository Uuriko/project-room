// Zero-bug gate: scan the PR diff for committed secrets.
// Usage: node scripts/scan-secrets.mjs [--base <git-ref>] [--diff <file>]
// Default base: origin/main. CI passes the PR base SHA explicitly.
// Exit 0: no secrets found. Exit 1: at least one finding (blocks the PR).
//
// Only ADDED lines (+ lines, excluding the +++ header) are scanned, so
// pre-existing history never blocks a new PR.
//
// Pattern list is deliberately conservative (high-precision, low recall):
// every pattern anchors on a known provider prefix. Generic "high entropy
// string" heuristics are NOT used — they false-positive on hashes, UUIDs,
// and test fixtures.
//
// Explicit escape hatch: append `secrets-allowlist` (case-insensitive) to
// the line, e.g. `const EXAMPLE = "AKIAIOSFODNN7EXAMPLE"; // secrets-allowlist`
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

const allowlistMarker = /secrets?-allow(list|ed)?/i;
// Placeholder-looking values never count as findings.
const placeholderRe = /(example|placeholder|fake|dummy|sample|changeme|todo|xxx|your[-_ ]?(key|secret|token)|<[^>]*>|\*{4,})/i;

const PATTERNS = [
  { name: "AWS access key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "AWS secret key", re: /\baws[_-]?secret[_-]?access[_-]?key\b['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i },
  { name: "AWS session token", re: /\baws[_-]?session[_-]?token\b['"]?\s*[:=]\s*['"]?[A-Za-z0-9/+=]{32,}['"]?/i },
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub classic token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Stripe live key", re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/ },
  { name: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "Bearer token", re: /\bbearer\s+[A-Za-z0-9\-._~+/=]{20,}\b/i },
  {
    name: "generic api-key/secret assignment",
    re: /\b(api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token)\b['"]?\s*[:=]\s*['"]([A-Za-z0-9\-._~+/=]{16,})['"]/i,
  },
  // Wallet seed phrase: 12-24 lowercase words with explicit seed/mnemonic/
  // recovery context, quoted. A committed mnemonic is a drained wallet.
  {
    name: "wallet seed phrase",
    re: /\b(?:seed[_-]?phrase|mnemonic|recovery[_-]?phrase)\b\s*[:=]\s*["']([a-z]+(?:\s+[a-z]+){11,23})["']/i,
  },
];

function getDiff(base, diffFile) {
  if (diffFile) {
    return readFileSync(diffFile, "utf8");
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const r = spawnSync("git", ["--no-pager", "diff", "--no-color", "--no-ext-diff", "-U0", `${base}...HEAD`, "--"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`scan-secrets: git diff ${base}...HEAD failed:\n${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
}

function main() {
  const base = flag("--base") || process.env.ZERO_BUG_BASE || "origin/main";
  const diffText = getDiff(base, flag("--diff"));
  const findings = [];
  let file = null;
  let newLine = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/ b\/(.+)$/);
      file = m ? m[1] : null;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const line = raw.slice(1);
    const at = `${file}:${newLine}`;
    newLine += 1;
    if (!file || allowlistMarker.test(line)) continue;
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      const matched = m[0];
      // AWS example keys and other documented placeholders are not secrets.
      if (placeholderRe.test(matched) || placeholderRe.test(line)) continue;
      findings.push({ at, kind: p.name, line: line.trim().slice(0, 160) });
      break; // one finding per line is enough
    }
  }
  if (findings.length === 0) {
    console.log(`scan-secrets: clean (${base}...HEAD)`);
    return;
  }
  console.error(`scan-secrets: ${findings.length} possible secret(s) in added lines:`);
  for (const f of findings) console.error(`  ${f.at} [${f.kind}] ${f.line}`);
  console.error("\nIf a finding is a documented placeholder, add `secrets-allowlist` to the line.");
  process.exit(1);
}

main();
