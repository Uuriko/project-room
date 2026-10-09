// browser-shards-check.mjs receipt robustness: a corrupt or non-file receipt
// is a clean gate failure (exit 1, one-line stderr naming the file), never an
// unhandled stack trace. Valid receipts still pass.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { browserPlan } from "../scripts/browser-shards.mjs";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..");
const checkScript = join(repoRoot, "scripts", "browser-shards-check.mjs");
const baseEnv = {
  ...process.env,
  BROWSER_MATRIX_RESULT: "success",
  GITHUB_SHA: "fixture-revision",
  GITHUB_RUN_ID: "fixture-run",
  GITHUB_RUN_ATTEMPT: "1",
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "browser-shards-check-receipts-"));
  const files = Array.from({ length: 6 }, (_, i) => `scripts/check-${i}.mjs`);
  const script = `node --test --test-concurrency=1 ${files.join(" ")}`;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "test:browser": script } }));
  const plan = browserPlan(script);
  const receipts = join(dir, "receipts");
  mkdirSync(receipts);
  for (const shard of plan.shards) {
    writeFileSync(join(receipts, `browser-shard-${shard.index}-of-6-attempt-1.json`), JSON.stringify({
      index: shard.index, total: 6, status: 0, signal: null,
      planHash: plan.planHash, revision: "fixture-revision", runId: "fixture-run",
      runAttempt: "1", files: shard.files,
    }));
  }
  return { dir, receipts };
}

function gate(dir, receipts) {
  return spawnSync(process.execPath, [checkScript, receipts], {
    cwd: dir, env: baseEnv, encoding: "utf8", timeout: 30000,
  });
}

test("valid receipts pass the gate", t => {
  const { dir, receipts } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = gate(dir, receipts);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("a corrupt receipt fails cleanly: exit 1, one line naming the file, no stack", t => {
  const { dir, receipts } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = join(receipts, "browser-shard-9-of-6-attempt-1.json");
  writeFileSync(bad, "not json{{{");
  const run = gate(dir, receipts);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const lines = run.stderr.trim().split("\n");
  assert.equal(lines.length, 1, `single-line stderr, got: ${run.stderr}`);
  assert.match(lines[0], /cannot read receipt .*browser-shard-9-of-6-attempt-1\.json/);
  assert.ok(!/at .*\(node:internal/.test(run.stderr), "no stack trace");
});

test("a directory matching the receipt glob fails cleanly too", t => {
  const { dir, receipts } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(receipts, "browser-shard-9-of-6-attempt-1.json"));
  const run = gate(dir, receipts);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const lines = run.stderr.trim().split("\n");
  assert.equal(lines.length, 1, `single-line stderr, got: ${run.stderr}`);
  assert.match(lines[0], /cannot read receipt .*browser-shard-9-of-6-attempt-1\.json/);
  assert.ok(!/at .*\(node:internal/.test(run.stderr), "no stack trace");
});
