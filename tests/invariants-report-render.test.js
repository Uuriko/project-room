// Invariants markdown renderer — fail-first tests.
//
// Contract under test (docs/INVARIANTS-TELEMETRY.md):
// - renders the latest run in a results file as a markdown table
// - default file: $INVARIANTS_RESULTS_FILE, else newest results/invariants*.jsonl
// - exit 0 after rendering; exit 2 when no results file exists
// - --fail-on-fail exits 1 when the latest run has any fail/error
// - escapes markdown-breaking characters in names/messages
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InvariantsReporter } from "../scripts/invariants-reporter.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = join(REPO_ROOT, "scripts", "invariants-report.mjs");

function freshDir() {
  return mkdtempSync(join(tmpdir(), "inv-report-"));
}

function seedRun(out, sha, rows) {
  const rep = new InvariantsReporter({ outPath: out, sha });
  rep.startRun();
  for (const r of rows) rep.record(r);
  return rep.endRun();
}

function render(out, args = [], extraEnv = {}) {
  const env = { ...process.env, INVARIANTS_RESULTS_FILE: out, ...extraEnv };
  try {
    const stdout = execFileSync(process.execPath, [RENDER, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

test("renders a markdown table with SHA, per-invariant rows, and counts", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    seedRun(out, "f48be87fc1", [
      { name: "mint-throttle", status: "pass", durationMs: 14 },
      { name: "claim-release-cas", status: "fail", durationMs: 203, message: "compare-and-swap lost" },
      { name: "unrun-thing", status: "skip", durationMs: 0, message: "needs staging" },
      { name: "flaky-env", status: "error", durationMs: 5, message: "setup threw" },
    ]);
    const { code, stdout } = render(out);
    assert.equal(code, 0);
    assert.match(stdout, /## Invariant results/);
    assert.match(stdout, /`f48be87fc1`/);
    assert.match(stdout, /\| mint-throttle \| ✅ pass \| 14 ms \|/);
    assert.match(stdout, /\| claim-release-cas \| ❌ fail \| 203 ms \| compare-and-swap lost \|/);
    assert.match(stdout, /\| unrun-thing \| ⏭️ skip \| 0 ms \| needs staging \|/);
    assert.match(stdout, /\| flaky-env \| ⚠️ error \| 5 ms \| setup threw \|/);
    assert.match(stdout, /\*\*1 pass · 1 fail · 1 skip · 1 error\*\*/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renders only the latest run when the file holds several", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    seedRun(out, "sha-old", [{ name: "old-inv", status: "fail", durationMs: 1 }]);
    seedRun(out, "sha-new", [{ name: "new-inv", status: "pass", durationMs: 2 }]);
    const { code, stdout } = render(out);
    assert.equal(code, 0);
    assert.match(stdout, /new-inv/);
    assert.doesNotMatch(stdout, /old-inv/);
    assert.match(stdout, /2 runs in file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escapes pipes in names and messages so the table survives", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    seedRun(out, "sha1", [{ name: "weird|name", status: "fail", durationMs: 1, message: "a|b" }]);
    const { stdout } = render(out);
    assert.match(stdout, /weird\\\|name/);
    assert.match(stdout, /a\\\|b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fail-on-fail exits 1 on a failing run and 0 on an all-pass run", () => {
  const dir = freshDir();
  try {
    const bad = join(dir, "bad.jsonl");
    seedRun(bad, "s", [{ name: "x", status: "fail", durationMs: 1 }]);
    assert.equal(render(bad, ["--fail-on-fail"]).code, 1);

    const good = join(dir, "good.jsonl");
    seedRun(good, "s", [{ name: "x", status: "pass", durationMs: 1 }]);
    assert.equal(render(good, ["--fail-on-fail"]).code, 0);

    // without the flag, a failing run still renders with exit 0
    assert.equal(render(bad).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing results file exits 2 with a stderr explanation", () => {
  const dir = freshDir();
  try {
    const missing = join(dir, "nope.jsonl");
    const { code, stderr } = render(missing);
    assert.equal(code, 2);
    assert.match(stderr, /no invariant results/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--out writes the markdown to a file instead of stdout", () => {
  const dir = freshDir();
  try {
    const out = join(dir, "invariants.jsonl");
    seedRun(out, "sha9", [{ name: "x", status: "pass", durationMs: 1 }]);
    const md = join(dir, "report.md");
    const { code, stdout } = render(out, ["--out", md]);
    assert.equal(code, 0);
    assert.equal(stdout, "");
    const written = readFileSync(md, "utf8");
    assert.match(written, /## Invariant results/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
