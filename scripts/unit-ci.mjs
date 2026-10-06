#!/usr/bin/env node
// CI wrapper for one shard of `npm test` (CI-speed lane).
//
// Runs the shard's tests/*.test.js files with `node --test` and writes a
// receipt under test-results/ for scripts/unit-shards-check.mjs. The receipt
// binds the shard to the exact plan (planHash), run, revision and attempt so
// the `unit` merge gate can fail closed on stale or partial evidence.
//
// Usage: node scripts/unit-ci.mjs --shard=1/3   (run from the repo root)
// TMPDIR must point at the worktree .tmp/ (never the shared /tmp tmpfs).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { unitPlan, parseShard } from "./unit-shards.mjs";

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || !argv[0].startsWith("--shard=")) {
    throw new Error("Usage: node scripts/unit-ci.mjs --shard=1/3");
  }
  const shard = parseShard(argv[0].slice("--shard=".length));
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
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
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
  process.exit(status);
}

main();
