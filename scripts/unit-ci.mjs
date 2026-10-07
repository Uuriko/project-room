#!/usr/bin/env node
// CI wrapper for one shard of `npm test` (CI-speed lane).
//
// Runs the shard's Node-discovered test files with `node --test` and writes a
// receipt under test-results/ for scripts/unit-shards-check.mjs. The receipt
// binds the shard to the exact plan (planHash), run, revision and attempt so
// the `unit` merge gate can fail closed on stale or partial evidence. The
// shard also collects V8 coverage from its test processes and writes a
// compact covered-line summary (test-results/coverage-shard-<i>.json) for the
// coverage gate — raw payloads stay in worktree-local scratch and are deleted.
//
// Usage: node scripts/unit-ci.mjs --shard=1/3   (run from the repo root)
// Use worktree-local scratch by default; create explicit TMPDIR before children.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { unitPlan, parseShard } from "./unit-shards.mjs";

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || !argv[0].startsWith("--shard=")) {
    throw new Error("Usage: node scripts/unit-ci.mjs --shard=1/3");
  }
  const shard = parseShard(argv[0].slice("--shard=".length));
  // Fresh checkouts do not contain ignored .tmp/. Initialize before both
  // dependency preflight and test children, matching scripts/test-env.sh.
  const worktreeScratch = resolve(".tmp");
  mkdirSync(worktreeScratch, { recursive: true });
  process.env.TMPDIR = resolve(process.env.TMPDIR || worktreeScratch);
  mkdirSync(process.env.TMPDIR, { recursive: true });
  if (!process.env.XDG_RUNTIME_DIR) process.env.XDG_RUNTIME_DIR = process.env.TMPDIR;
  const preflight = spawnSync(process.execPath, ["scripts/check-deps.mjs"], { stdio: "inherit" });
  if (preflight.error) throw preflight.error;
  if (preflight.status !== 0) process.exit(preflight.status ?? 1);
  const plan = unitPlan();
  const files = plan.shards[shard.index - 1].files;
  if (!files.length) throw new Error("Refusing an empty unit shard");
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "local";
  const receiptPath = `test-results/unit-shard-${shard.index}-of-${shard.total}-attempt-${attempt}.json`;
  mkdirSync(dirname(receiptPath), { recursive: true });
  rmSync(receiptPath, { force: true });
  console.log(`unit-ci: shard ${shard.index}/${shard.total}, ${files.length} test files`);
  const started = Date.now();
  // V8 coverage from the shard's test processes, collected into worktree-local
  // scratch (raw payloads are far too large for the evidence artifact). The
  // coverage gate summarizes and unions these per shard instead of re-running
  // the whole suite.
  const coverageRawDir = join(worktreeScratch, `coverage-raw-shard-${shard.index}`);
  rmSync(coverageRawDir, { recursive: true, force: true });
  mkdirSync(coverageRawDir, { recursive: true });
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    env: { ...process.env, NODE_V8_COVERAGE: coverageRawDir },
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        ...shard,
        files,
        planHash: plan.planHash,
        status,
        signal: result.signal,
        revision: process.env.GITHUB_SHA ?? "local",
        runId: process.env.GITHUB_RUN_ID ?? "local",
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
        elapsedMs: Date.now() - started,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`unit-ci: shard ${shard.index}/${shard.total} exit ${status} in ${Math.round((Date.now() - started) / 1000)}s`);
  // Compact covered-line summary for the coverage gate. Best-effort: a broken
  // summarizer must not fail the shard — the coverage gate fails closed on a
  // missing summary instead. Raw payloads are deleted; only the summary rides
  // the evidence artifact.
  const summaryPath = resolve(`test-results/coverage-shard-${shard.index}.json`);
  const summarized = spawnSync(
    process.execPath,
    ["scripts/coverage-thresholds.mjs", "--summarize", "--coverage-dir", coverageRawDir, "--out", summaryPath],
    { stdio: "inherit" }
  );
  rmSync(coverageRawDir, { recursive: true, force: true });
  if ((summarized.status ?? 1) !== 0) {
    console.error(`unit-ci: coverage summarization failed; coverage gate will fail closed on the missing summary`);
  }
  process.exit(status);
}

main();
