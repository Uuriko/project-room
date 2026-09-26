// tests/secret-scan-diff.test.js — contract tests for the PR diff gate
// (scripts/secret-scan-diff.mjs).
//
// What this protects (test-audit authoring gate):
//  1. Behavior: the diff gate flags secret-shaped ADDED lines (11 seeded
//     rules, generated at runtime) and stays silent on the current main
//     tree — the zero-false-positive acceptance for the CI gate.
//  2. Credible regressions: parseDiff scanning removed lines or misreporting
//     line numbers; wrong CLI exit codes; the path-allowlist loader dropping
//     entries; a broken shared-ALLOWLIST import (import-time side effects);
//     finding output echoing secret values into CI logs.
//  3. No existing coverage: tests/secret-scan.test.js covers the detector
//     (server/secret-scan.mjs) only; the diff gate is new.
//  4. No test-only production seam: tests import the CLI module's own
//     functions (parseDiff, scanAddedUnits, loadPathAllowlist), which the
//     CLI itself calls, and exercise exit codes through the real entrypoint.
//
// NOTE: like the detector tests, all example secrets are generated at
// runtime so this file never contains a literal secret-shaped string
// (GitHub push protection). Probe repos live under os.tmpdir() (the
// worktree .tmp/ when run via scripts/test-env.sh) and are destroyed with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isInScope,
  isPathAllowlisted,
  loadPathAllowlist,
  parseDiff,
  scanAddedUnits,
} from "../scripts/secret-scan-diff.mjs";
import { ALLOWLIST, SKIP_FILES } from "../scripts/secret-scan-check.mjs";
import { scanText } from "../server/secret-scan.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATE = path.join(REPO_ROOT, "scripts", "secret-scan-diff.mjs");

// --- runtime-generated seeds (never committed as literals) -----------------

const fakeAwsKey = () =>
  "AKIA" + randomBytes(12).toString("hex").toUpperCase().slice(0, 16);
const fakeAwsSecret = () =>
  `aws_secret_access_key = "${randomBytes(20).toString("hex")}"`;
const fakeGithubToken = () => "ghp_" + randomBytes(18).toString("hex");
const fakeApiKey = () => `api_key = "${randomBytes(16).toString("hex")}"`;
const fakePassword = () => `password = "${randomBytes(10).toString("hex")}"`;
const fakePrivateKey = () => "-----BEGIN RSA PRIVATE KEY-----";
const fakeBearer = () => `Authorization: Bearer ${randomBytes(16).toString("hex")}`;
const fakeSlack = () => `slack_token = "xoxb-${randomBytes(9).toString("hex")}"`;
const fakeStripe = () => `stripe = "sk_test_${randomBytes(16).toString("hex")}"`;
const fakeBotToken = () => {
  const botId = String(100000000 + Math.floor(Math.random() * 899999999));
  const secret = randomBytes(26)
    .toString("base64url")
    .replace(/[^A-Za-z0-9_-]/g, "x")
    .slice(0, 35);
  return `bot_token = "${botId}:${secret}"`;
};
// Deterministic PRNG for the high-entropy seed (same rationale as
// tests/secret-scan.test.js: a true random draw can dip below the entropy
// threshold and flake CI).
const prngBytes = (seed, n) => {
  let s = seed >>> 0;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
};
const fakeHighEntropy = () =>
  `deploy_token = "${prngBytes(0x5EED, 32).toString("base64url")}"`;

const SEEDS = [
  ["aws-access-key", fakeAwsKey],
  ["aws-secret-key", fakeAwsSecret],
  ["github-token", fakeGithubToken],
  ["generic-api-key", fakeApiKey],
  ["generic-secret", fakePassword],
  ["private-key", fakePrivateKey],
  ["bearer-token", fakeBearer],
  ["slack-token", fakeSlack],
  ["stripe-key", fakeStripe],
  ["telegram-bot-token", fakeBotToken],
  ["high-entropy", fakeHighEntropy],
];

// --- unit: diff parsing -----------------------------------------------------

test("parseDiff scans added lines only, with paths and new line numbers", () => {
  const diff = [
    "diff --git a/foo.txt b/foo.txt",
    "index 1111111..2222222 100644",
    "--- a/foo.txt",
    "+++ b/foo.txt",
    "@@ -1,2 +1,3 @@",
    " context line",
    '-old_token = "no-longer-here"',
    "+added clean line",
    "+added second line",
  ].join("\n");
  assert.deepEqual(
    parseDiff(diff).map((u) => [u.path, u.line, u.text]),
    [
      ["foo.txt", 2, "added clean line"],
      ["foo.txt", 3, "added second line"],
    ]
  );
});

test("parseDiff skips deleted files and binary diffs", () => {
  const diff = [
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone = 1",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
  ].join("\n");
  assert.deepEqual(parseDiff(diff), []);
});

test("scanAddedUnits maps findings back to new line numbers", () => {
  const units = [
    { path: "a.txt", line: 10, text: "clean line" },
    { path: "a.txt", line: 11, text: `key = "${fakeAwsKey()}"` },
  ];
  const findings = scanAddedUnits(units, []);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^a\.txt:11 \[aws-access-key\]/);
});

test("path allowlist loader requires a reason and matches globs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "secret-scan-diff-allow-"));
  const p = path.join(dir, "allowlist.txt");
  writeFileSync(
    p,
    ["# comment", "", "tests/fixtures/*  # seeded fixtures", "no-reason"].join("\n")
  );
  const entries = loadPathAllowlist(p);
  assert.equal(entries.length, 1);
  assert.ok(isPathAllowlisted("tests/fixtures/x.txt", entries));
  assert.ok(!isPathAllowlisted("tests/other.txt", entries));
  assert.deepEqual(loadPathAllowlist(path.join(dir, "missing.txt")), []);
});

// --- e2e: the real CLI against a temp git repo -------------------------------

function initTempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "secret-scan-diff-repo-"));
  const git = (args, opts = {}) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", ...opts });
  git(["init", "-q"]);
  git(["config", "user.email", "secret-scan-test@example.com"]);
  git(["config", "user.name", "secret-scan-test"]);
  writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  return { dir, sha, git };
}

function runGate(args, cwd) {
  return spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    cwd,
  });
}

test("CLI flags all 11 seeded rules on added lines (exit 1)", () => {
  const { dir, sha } = initTempRepo();
  const values = SEEDS.map(([, gen]) => gen());
  // Each seed is already a full line (or a bare value); write them
  // unwrapped so every rule sees its natural shape.
  const probe = values.join("\n") + "\n";
  writeFileSync(path.join(dir, "probe.txt"), probe);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "add probe"]);

  const r = runGate(["--base", sha, "--allowlist", "none"], dir);
  assert.equal(r.status, 1, `expected exit 1, stderr: ${r.stderr}`);
  for (const [rule] of SEEDS) {
    assert.match(r.stdout, new RegExp(`\\[${rule}\\]`), `missing rule ${rule}`);
  }
  for (const v of values) {
    assert.ok(
      !r.stdout.includes(v),
      "CLI output must never echo a secret value"
    );
  }
});

test("CLI exits 0 for a clean diff and for allowlisted paths", () => {
  const { dir, sha } = initTempRepo();

  // Clean change.
  writeFileSync(path.join(dir, "clean.txt"), 'greeting = "hello world"\n');
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "clean"]);
  let r = runGate(["--base", sha, "--allowlist", "none"], dir);
  assert.equal(r.status, 0, `expected exit 0, output: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /clean/);

  // Dirty change, then allowlisted by path.
  const secret = fakeGithubToken();
  writeFileSync(path.join(dir, "dirty.txt"), `token = "${secret}"\n`);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "dirty"]);
  r = runGate(["--base", sha, "--allowlist", "none"], dir);
  assert.equal(r.status, 1);
  const allow = path.join(dir, "allow.txt");
  writeFileSync(allow, "dirty.txt  # test-only probe exemption\n");
  r = runGate(["--base", sha, "--allowlist", allow], dir);
  assert.equal(r.status, 0, `expected exit 0, output: ${r.stdout} ${r.stderr}`);
});

test("CLI --staged scans staged changes (pre-commit path)", () => {
  const { dir } = initTempRepo();
  const secret = fakeStripe();
  writeFileSync(path.join(dir, "staged.txt"), `${secret}\n`);
  execFileSync("git", ["-C", dir, "add", "staged.txt"]);
  const r = runGate(["--staged", "--allowlist", "none"], dir);
  assert.equal(r.status, 1, `expected exit 1, output: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /\[stripe-key\]/);
  assert.ok(!r.stdout.includes(secret));
});

test("CLI rejects unknown flags (exit 2)", () => {
  const { dir } = initTempRepo();
  const r = runGate(["--bogus"], dir);
  assert.equal(r.status, 2);
});

// --- acceptance: zero false positives against current main -------------------

test("zero false positives against the origin/main tree", () => {
  // The diff gate reuses the detector + shared line allowlist under the
  // tree scan's scope policy: whatever main contains in scope today must
  // not trip it, or PRs touching those lines would fail the gate.
  const dir = mkdtempSync(path.join(os.tmpdir(), "secret-scan-diff-main-"));
  const archive = execFileSync("git", ["-C", REPO_ROOT, "archive", "origin/main"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const tar = spawnSync("tar", ["-x", "-C", dir], { input: archive });
  assert.equal(tar.status, 0, "git archive extract failed");

  const findings = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if ([".git", "node_modules"].includes(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        // Same scope + skip policy as the gate itself.
        if (!isInScope(rel)) continue;
        if (SKIP_FILES.some((re) => re.test(rel))) continue;
        let buf;
        try {
          buf = readFileSync(abs);
        } catch {
          continue;
        }
        if (buf.length > 2 * 1024 * 1024) continue;
        if (buf.subarray(0, 8000).includes(0)) continue; // binary
        for (const f of scanText(buf.toString("utf8"), { allowlist: ALLOWLIST })) {
          findings.push(`${rel}:${f.line} [${f.rule}]`);
        }
      }
    }
  };
  walk(dir);
  assert.deepEqual(findings, [], `false positives on main:\n${findings.join("\n")}`);
});

test("the gate's own new files do not self-flag", () => {
  // The diff gate scans added lines: this repo's own new files must be
  // clean under the gate's config, or the PR itself would fail the gate.
  const allowlist = loadPathAllowlist(
    path.join(REPO_ROOT, ".github", "secret-scan-allowlist.txt")
  );
  const out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const units = [];
  for (const rel of out.split("\0").filter(Boolean)) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue;
    buf
      .toString("utf8")
      .split("\n")
      .forEach((text, idx) => units.push({ path: rel, line: idx + 1, text }));
  }
  const findings = scanAddedUnits(units, allowlist);
  assert.deepEqual(findings, [], `self-flagged files:\n${findings.join("\n")}`);
});
