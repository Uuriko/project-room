// WAVE-2000 G06 worker-25 shard hardening (scripts at index % 50 == 24).
//
// F1: scripts/release-evidence.mjs: a malformed --probes JSON file crashes with
// an uncaught SyntaxError stack (exit 1) instead of a clean usage error (exit 2).
// F2: scripts/coverage-thresholds.mjs formatReport:
//   a. the per-module [ok]/[FAIL] tag uses a raw `pct < threshold` compare while
//      checkThresholds floors to 0.1 precision, so the report can print [ok] for
//      a module the gate actually failed (e.g. pct 95.65 vs threshold 95.65);
//   b. the "files with zero coverage data" suffix prints whenever
//      zeroCoverageFiles is a (truthy) empty array, rendering as
//      "—  files with zero coverage data".
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkThresholds, formatReport } from "../scripts/coverage-thresholds.mjs";

const releaseEvidence = fileURLToPath(new URL("../scripts/release-evidence.mjs", import.meta.url));
const tapPassed = "TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";

function gitFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "w25-release-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "candidate.txt"), "Committed candidate\n");
  const git = args => execFileSync("git", ["-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Worker25 fixture", "-c", "user.email=fixture@example.invalid", ...args],
  { cwd: checkout, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["add", "candidate.txt"]);
  git(["commit", "--quiet", "-m", "Worker25 fixture"]);
  const tap = join(dir, "tap.txt");
  writeFileSync(tap, tapPassed);
  return { dir, checkout, tap };
}

function runReleaseEvidence(checkout, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [releaseEvidence, ...args], { cwd: checkout, encoding: "utf8", timeout: 15000 },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" }));
  });
}

test("F1: malformed --probes JSON is a clean usage error (exit 2), not an uncaught stack trace", async t => {
  const { dir, checkout, tap } = gitFixture(t);
  const probes = join(dir, "probes.json");
  writeFileSync(probes, "not valid json{{{");
  const r = await runReleaseEvidence(checkout, ["--tap", tap, "--probes", probes]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /probes/i, "stderr should name the --probes file");
  assert.doesNotMatch(r.stderr, /SyntaxError|at main|node:internal/, "no stack trace on a usage error");
});

test("F1: missing --probes file is also a clean usage error (exit 2)", async t => {
  const { dir, checkout, tap } = gitFixture(t);
  const r = await runReleaseEvidence(checkout, ["--tap", tap, "--probes", join(dir, "nope.json")]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /probes/i);
});

const moduleResults = pct => ({
  m: { dir: "server", threshold: 95.65, files: 1, covered: 100, coverable: 100, pct,
    zeroCoverageFiles: [], lowestFiles: [] },
});
const config = { modules: { m: { dir: "server", threshold: 95.65 } } };

test("F2a: formatReport [ok]/[FAIL] tag matches checkThresholds at the float-floor boundary", () => {
  const results = moduleResults(95.65);
  const check = checkThresholds(config, results);
  assert.equal(check.ok, false, "gate fails at the float-floor boundary (existing epsilon behavior)");
  const report = formatReport(results, check);
  assert.match(report, /\[FAIL\] m\//, "report row must say [FAIL] when the gate failed");
  assert.doesNotMatch(report, /\[ok\] m\//);
});

test("F2a: report still says [ok] when the gate passes", () => {
  const results = moduleResults(95.7);
  const check = checkThresholds(config, results);
  assert.equal(check.ok, true);
  assert.match(formatReport(results, check), /\[ok\] m\//);
});

test("F2b: no 'zero coverage data' suffix when zeroCoverageFiles is an empty array", () => {
  const report = formatReport(moduleResults(100), checkThresholds(config, moduleResults(100)));
  assert.doesNotMatch(report, /zero coverage data/);
});

test("F2b: suffix appears with the real count when files lack coverage data", () => {
  const results = moduleResults(100);
  results.m.zeroCoverageFiles = ["server/a.mjs", "server/b.mjs"];
  assert.match(formatReport(results, checkThresholds(config, results)), /2 files with zero coverage data/);
});

test("meetsThreshold: 0.1-precision epsilon behavior is shared by gate and report", async () => {
  const { meetsThreshold } = await import("../scripts/coverage-thresholds.mjs");
  assert.equal(meetsThreshold(95.64, 95.6), true, "95.64 vs 95.6 passes (floored epsilon)");
  assert.equal(meetsThreshold(95.59, 95.6), false);
  assert.equal(meetsThreshold(100, 100), true);
  assert.equal(meetsThreshold(0, 0), true);
});
