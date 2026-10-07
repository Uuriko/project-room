#!/usr/bin/env node
// CI wrapper for one shard of `npm test` (CI-speed lane).
//
// Runs the shard's Node-discovered test files with `node --test` and writes a
// receipt under test-results/ for scripts/unit-shards-check.mjs. The receipt
// binds the shard to the exact plan (planHash), run, revision and attempt so
// the `unit` merge gate can fail closed on stale or partial evidence. The
// shard also records per-file wall times
// (test-results/unit-file-durations-<i>-of-3.json) for the shard balancer's
// self-update (scripts/unit-durations-refresh.mjs); the durations file rides
// the existing evidence artifact and the gate ignores it.
//
// Usage: node scripts/unit-ci.mjs --shard=1/3   (run from the repo root)
// Use worktree-local scratch by default; create explicit TMPDIR before children.
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { unitPlan, parseShard } from "./unit-shards.mjs";
import { parseFailingTests } from "./failing-tests.mjs";

/**
 * Run test files with `node --test`, teeing the reporter stream to the console.
 * Returns { status, signal, failures }: failing test names parsed from the
 * spec-reporter output (advisory — [] on success or when nothing parsed).
 * `extraReporters` is an optional flat list of `--test-reporter` /
 * `--test-reporter-destination` pairs inserted before the file positionals
 * (node --test only honors --test* options placed before the files).
 */
export function runTestFiles(files, extraReporters = []) {
  // A child `node --test` spawned from inside a test-runner process refuses
  // to run ("recursively ... skipping running files") when it inherits
  // NODE_TEST_CONTEXT. Drop it so the child is always a fresh top-level
  // runner, whether invoked from CI or from a test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // Pipe (not inherit) so failing test names can be parsed out of the
  // reporter stream for the shard receipt; tee both streams to the console
  // so the job log keeps its exact old shape.
  const result = spawnSync(process.execPath, ["--test", ...extraReporters, ...files], {
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout?.toString("utf8") ?? "";
  const stderr = result.stderr?.toString("utf8") ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const status = result.status ?? 1;
  // Failing names are advisory: a red shard must still produce its receipt so
  // the merge gate fails closed on the receipt, and the PR comment step names
  // the failures instead of pointing at the log.
  const failures = status === 0 ? [] : parseFailingTests(stdout);
  return { status, signal: result.signal, failures };
}

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
  // Per-file duration capture for the shard balancer's self-update: an extra
  // reporter pair writes the per-file wall times next to the receipt, where
  // the unit-shard-evidence artifact picks them up. Best-effort — it must
  // never fail the shard. The default console reporter is reproduced
  // explicitly (spec -> stdout) so log output is unchanged, since passing
  // --test-reporter replaces the default.
  const durationsPath = resolve(`test-results/unit-file-durations-${shard.index}-of-${shard.total}.json`);
  const durationsReporter = fileURLToPath(new URL("./unit-file-durations-reporter.mjs", import.meta.url));
  let extraReporters = [];
  if (existsSync(durationsReporter)) {
    extraReporters = [
      "--test-reporter", "spec", "--test-reporter-destination", "stdout",
      "--test-reporter", durationsReporter, "--test-reporter-destination", durationsPath,
    ];
  } else {
    console.error("unit-ci: unit-file-durations-reporter.mjs missing; skipping per-file duration capture");
  }
  const { status, signal, failures } = runTestFiles(files, extraReporters);
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        ...shard,
        files,
        planHash: plan.planHash,
        status,
        signal,
        failures,
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

const invokedAsScript =
  process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (invokedAsScript) main();
