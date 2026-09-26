#!/usr/bin/env node
// Secret-scan DIFF gate (200-list #162). Scans ADDED lines of
// `git diff <base>...HEAD` for secrets using the shared detector
// (server/secret-scan.mjs) with the shared line allowlist plus a
// path-based allowlist (.github/secret-scan-allowlist.txt).
//
// Complements the tree scan in scripts/secret-scan-check.mjs (contract
// job): this gate is PR-focused and fast (added lines only), reusing the
// tree scan's scope policy so the two never disagree. Findings never
// include secret values — only the detector's redacted previews.
//
// Usage:
//   node scripts/secret-scan-diff.mjs [--base <ref>]   # scan <ref>...HEAD (default: origin/main)
//   node scripts/secret-scan-diff.mjs --staged        # scan staged changes (pre-commit hook)
//   node scripts/secret-scan-diff.mjs --files a b c   # scan file contents directly
//   node scripts/secret-scan-diff.mjs --allowlist <path>|none
//
// Exit codes: 0 = clean, 1 = findings, 2 = usage/environment error.
// Stdlib only — no npm install needed, so the CI workflow skips `npm ci`.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scanLines } from "../server/secret-scan.mjs";
import { ALLOWLIST, SKIP_FILES, SCAN_DIRS, SCAN_EXT } from "./secret-scan-check.mjs";

// ---------------------------------------------------------------------------
// Path-based allowlist (.github/secret-scan-allowlist.txt)
// ---------------------------------------------------------------------------
// One repo-root-relative path glob per line; every entry MUST carry a reason
// after `#` — entries without one are ignored so exemptions stay reviewable.
// (The line-content allowlist shared with the tree scan lives in
// scripts/secret-scan-check.mjs as ALLOWLIST.)

export function loadPathAllowlist(allowlistPath) {
  if (!allowlistPath || !existsSync(allowlistPath)) return [];
  const entries = [];
  for (const raw of readFileSync(allowlistPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hash = line.indexOf("#");
    if (hash === -1) continue; // reason required
    const pattern = line.slice(0, hash).trim();
    const reason = line.slice(hash + 1).trim();
    if (!pattern || !reason) continue;
    entries.push({ pattern, reason });
  }
  return entries;
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

export function isPathAllowlisted(relPath, entries) {
  return entries.some((e) => globToRegExp(e.pattern).test(relPath));
}

// ---------------------------------------------------------------------------
// Diff parsing — added lines only, never removed/context lines
// ---------------------------------------------------------------------------

export function parseDiff(diffText) {
  const added = [];
  let file = null;
  let newLine = 0;
  let skipFile = false;
  for (const rawLine of diffText.split("\n")) {
    const line = rawLine;
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      skipFile = p === "/dev/null";
      file = p.startsWith("b/") ? p.slice(2) : p;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      skipFile = true;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (file === null || skipFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ path: file, line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // removed line: the new-side line number does not advance
    } else if (!line.startsWith("\\")) {
      newLine++; // context line
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

function gitTopLevel() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function refResolves(ref) {
  try {
    execFileSync("git", ["cat-file", "-t", ref], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function diffAddedLines(base) {
  const out = execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...HEAD`, "--", "."],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return parseDiff(out);
}

function stagedAddedLines() {
  const out = execFileSync(
    "git",
    ["diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--", "."],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return parseDiff(out);
}

function headTreeUnits() {
  // Fail-closed fallback when the base ref does not resolve: scan the
  // whole HEAD tree instead of scanning nothing.
  const names = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const units = [];
  for (const rel of names) {
    let buf;
    try {
      buf = execFileSync("git", ["show", `HEAD:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    buf
      .toString("utf8")
      .split("\n")
      .forEach((text, idx) => units.push({ path: rel, line: idx + 1, text }));
  }
  return units;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function printUsage() {
  console.error(
    [
      "usage: node scripts/secret-scan-diff.mjs [--base <ref>] [--staged] [--files <paths...>]",
      "                                        [--allowlist <path>|none]",
      "",
      "  --base <ref>     scan added lines of <ref>...HEAD (default: origin/main)",
      "  --staged         scan staged changes instead of a diff (pre-commit hook)",
      "  --files <paths>  scan file contents directly",
      "  --allowlist <p>  path allowlist (default: <repo>/.github/secret-scan-allowlist.txt)",
      "  --allowlist none disable the path allowlist",
    ].join("\n")
  );
}

// Scope parity with the tree scan (scripts/secret-scan-check.mjs): only
// source dirs + repo-root files with scannable extensions. docs/, tests/
// and research/ are prose and fixtures by policy — the tree scan excludes
// them, so the diff gate does too (otherwise every docs PR with a long URL
// would trip the high-entropy rule).
export function isInScope(relPath) {
  const inDirs = SCAN_DIRS.some((d) => relPath === d || relPath.startsWith(`${d}/`));
  const isRootFile = !relPath.includes("/");
  if (!inDirs && !isRootFile) return false;
  return SCAN_EXT.test(relPath.split("/").pop());
}

// Scan added-line units; returns finding strings `path:line [rule] label (preview)`.
export function scanAddedUnits(units, pathAllowlist) {
  const byFile = new Map();
  for (const u of units) {
    if (!isInScope(u.path)) continue;
    if (isPathAllowlisted(u.path, pathAllowlist)) continue;
    if (SKIP_FILES.some((re) => re.test(u.path))) continue;
    if (!byFile.has(u.path)) byFile.set(u.path, []);
    byFile.get(u.path).push(u);
  }
  const findings = [];
  for (const [file, fileUnits] of byFile) {
    const texts = fileUnits.map((u) => u.text);
    const hits = scanLines(texts, { allowlist: ALLOWLIST });
    for (const h of hits) {
      const unit = fileUnits[h.line - 1];
      findings.push(`${file}:${unit.line} [${h.rule}] ${h.label} (${h.preview})`);
    }
  }
  return findings;
}

function run(argv) {
  let base = "origin/main";
  let staged = false;
  let files = null;
  let allowlistArg = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") base = argv[++i];
    else if (a === "--staged") staged = true;
    else if (a === "--allowlist") allowlistArg = argv[++i];
    else if (a === "--files") {
      files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) files.push(argv[++i]);
    } else if (a === "-h" || a === "--help") {
      printUsage();
      return 0;
    } else {
      console.error(`secret-scan-diff: unknown argument: ${a}`);
      printUsage();
      return 2;
    }
  }
  if (!base && !staged && !files) {
    console.error("secret-scan-diff: --base requires a value");
    return 2;
  }

  const top = gitTopLevel();
  const allowlistPath =
    allowlistArg === "none"
      ? null
      : allowlistArg || path.join(top, ".github", "secret-scan-allowlist.txt");
  const pathAllowlist = loadPathAllowlist(allowlistPath);

  let units;
  if (files) {
    units = [];
    for (const f of files) {
      const abs = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
      const rel = path.relative(top, abs) || path.basename(abs);
      let buf;
      try {
        buf = readFileSync(abs);
      } catch (e) {
        console.error(`secret-scan-diff: cannot read ${f}: ${e.message}`);
        return 2;
      }
      if (isBinary(buf)) continue;
      buf
        .toString("utf8")
        .split("\n")
        .forEach((text, idx) => units.push({ path: rel, line: idx + 1, text }));
    }
  } else if (staged) {
    units = stagedAddedLines();
  } else if (!refResolves(base)) {
    console.error(`secret-scan-diff: base ${base} does not resolve; scanning full HEAD tree`);
    units = headTreeUnits();
  } else {
    units = diffAddedLines(base);
  }

  const findings = scanAddedUnits(units, pathAllowlist);
  if (findings.length > 0) {
    console.log(`secret-scan-diff: ${findings.length} finding(s)`);
    for (const f of findings) console.log(`  ${f}`);
    console.log(
      "Remove the secret (rotate it if it was ever real), or add a path entry " +
        "with a reason to .github/secret-scan-allowlist.txt — see docs/SECRET-SCAN.md."
    );
    return 1;
  }
  console.log("secret-scan-diff: clean");
  return 0;
}

const invokedAsCli =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  (process.argv[1] ?? "").endsWith("/secret-scan-diff.mjs") ||
  (process.argv[1] ?? "").endsWith("\\secret-scan-diff.mjs");
if (invokedAsCli) {
  process.exitCode = run(process.argv.slice(2));
}
