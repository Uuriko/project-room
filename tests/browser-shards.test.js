import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { browserPlan, parseShard } from "../scripts/browser-shards.mjs";

// Real Node tests, real wrapper and real CLI gate: covers omission/duplication,
// lost child exit codes, missing matrix jobs and stale success artifacts.
// No production flags or mocked execution are needed.
test("four CLI shards execute each canonical test once and aggregate only complete current success", t => {
  const dir = mkdtempSync(join(tmpdir(), "browser-shards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  for (const name of ["browser-ci.mjs", "browser-ci-reporter.mjs", "browser-ci-durations.json", "browser-shards.mjs", "browser-shards-check.mjs"]) cpSync(join("scripts", name), join(dir, "scripts", name));
  const files = Array.from({ length: 9 }, (_, i) => `scripts/check-${i}.mjs`);
  for (const [i, file] of files.entries()) writeFileSync(join(dir, file), `import test from 'node:test'; import { appendFileSync } from 'node:fs'; test('browser case ${i}', () => { appendFileSync('executed.txt', '${i}\\n'); if (process.env.FAIL_CASE === '${i}') throw new Error('intentional child failure'); });\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "test:browser": `node --test --test-concurrency=1 ${files.join(" ")}` } }));
  const env = { ...process.env, GITHUB_SHA: "fixture-revision", GITHUB_RUN_ID: "fixture-run", GITHUB_RUN_ATTEMPT: "1", BROWSER_MATRIX_RESULT: "success" };
  delete env.NODE_TEST_CONTEXT; // The fixture launches an independent test runner, not a nested test file.
  const invoke = (file, args = [], more = {}) => spawnSync(process.execPath, [file, ...args], { cwd: dir, env: { ...env, ...more }, encoding: "utf8", timeout: 30000 });
  for (const invalid of ["--shard=0/4", "--shard=5/4", "--shard=1/0", "--shard=1/3", "--shard=NaN/4", "--unknown"]) assert.notEqual(invoke("scripts/browser-ci.mjs", [invalid]).status, 0, invalid);
  for (let index = 1; index <= 4; index++) {
    const run = invoke("scripts/browser-ci.mjs", [`--shard=${index}/4`]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(readFileSync(join(dir, `test-results/browser-junit-${index}-of-4.xml`), "utf8"), /<testcase /);
    assert.match(run.stdout, /Browser gate durations/);
  }
  assert.deepEqual(readFileSync(join(dir, "executed.txt"), "utf8").trim().split("\n").map(Number).sort((a,b) => a-b), [...files.keys()]);
  const gate = (more = {}) => invoke("scripts/browser-shards-check.mjs", ["test-results"], more);
  assert.equal(gate().status, 0);
  for (const state of ["failure", "cancelled", "skipped", ""]) assert.notEqual(gate({ BROWSER_MATRIX_RESULT: state }).status, 0, state);
  assert.notEqual(gate({ GITHUB_SHA: "different-revision" }).status, 0);
  assert.equal(gate({ GITHUB_RUN_ATTEMPT: "2" }).status, 0, "earlier-attempt receipts accepted by a re-run aggregator");
  const receiptPath = join(dir, "test-results/browser-shard-4-of-4-attempt-1.json");
  const receipt = readFileSync(receiptPath, "utf8");
  rmSync(receiptPath); assert.notEqual(gate().status, 0, "missing successful shard fails closed");
  writeFileSync(receiptPath, receipt);
  const altered = JSON.parse(receipt); altered.files.pop();
  writeFileSync(receiptPath, JSON.stringify(altered)); assert.notEqual(gate().status, 0, "omitted suite fails closed");
  writeFileSync(receiptPath, receipt);
  const plan = browserPlan(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts["test:browser"]);
  const failingShard = plan.shards.find(shard => shard.files.includes(files[0]));
  const failed = invoke("scripts/browser-ci.mjs", [`--shard=${failingShard.index}/4`], { FAIL_CASE: "0" });
  assert.notEqual(failed.status, 0, "child failure propagates");
  assert.match(failed.stdout, /intentional child failure/);
  assert.notEqual(gate().status, 0, "stale success is replaced by failure receipt");
});

test("single-shard re-run: latest attempt per shard wins, untouched shards keep earlier receipts", t => {
  const dir = mkdtempSync(join(tmpdir(), "browser-shards-rerun-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  for (const name of ["browser-ci.mjs", "browser-ci-reporter.mjs", "browser-ci-durations.json", "browser-shards.mjs", "browser-shards-check.mjs"]) cpSync(join("scripts", name), join(dir, "scripts", name));
  const files = Array.from({ length: 9 }, (_, i) => `scripts/check-${i}.mjs`);
  for (const [i, file] of files.entries()) writeFileSync(join(dir, file), `import test from 'node:test'; test('browser case ${i}', () => { if (process.env.FAIL_CASE === '${i}') throw new Error('intentional child failure'); });\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "test:browser": `node --test --test-concurrency=1 ${files.join(" ")}` } }));
  const base = { ...process.env, GITHUB_SHA: "rerun-revision", GITHUB_RUN_ID: "rerun-run", BROWSER_MATRIX_RESULT: "success" };
  delete base.NODE_TEST_CONTEXT;
  const invoke = (args = [], more = {}) => spawnSync(process.execPath, ["scripts/browser-ci.mjs", ...args], { cwd: dir, env: { ...base, ...more }, encoding: "utf8", timeout: 30000 });
  // Attempt 1: all four shards pass.
  for (let index = 1; index <= 4; index++) assert.equal(invoke([`--shard=${index}/4`], { GITHUB_RUN_ATTEMPT: "1" }).status, 0);
  const gate = (more = {}) => spawnSync(process.execPath, ["scripts/browser-shards-check.mjs", "test-results"], { cwd: dir, env: { ...base, GITHUB_RUN_ATTEMPT: "1", ...more }, encoding: "utf8", timeout: 30000 });
  assert.equal(gate().status, 0);
  const plan = browserPlan(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts["test:browser"]);
  const target = plan.shards.find(shard => shard.files.includes("scripts/check-1.mjs"));
  const shardArg = `--shard=${target.index}/4`;
  // Attempt 2: the target shard is re-run and fails. The aggregator (also
  // attempt 2) sees the failure receipt as the shard's latest and fails
  // closed, even though an attempt-1 success receipt still exists.
  assert.notEqual(invoke([shardArg], { GITHUB_RUN_ATTEMPT: "2", FAIL_CASE: "1" }).status, 0);
  const gate2 = (more = {}) => spawnSync(process.execPath, ["scripts/browser-shards-check.mjs", "test-results"], { cwd: dir, env: { ...base, GITHUB_RUN_ATTEMPT: "2", ...more }, encoding: "utf8", timeout: 30000 });
  assert.notEqual(gate2().status, 0, "re-run failure supersedes earlier success");
  assert.notEqual(gate2({ BROWSER_MATRIX_RESULT: "failure" }).status, 0);
  // Attempt 2 retry: the shard passes. Gate now passes on mixed attempts
  // (untouched shards from attempt 1; re-run shard from attempt 2).
  assert.equal(invoke([shardArg], { GITHUB_RUN_ATTEMPT: "2" }).status, 0);
  assert.equal(gate2().status, 0, "mixed-attempt success passes");
  // A receipt from a different run fails closed even at a higher attempt.
  writeFileSync(join(dir, "test-results/browser-shard-1-of-4-attempt-9.json"),
    JSON.stringify({ index: 1, total: 4, files: [], planHash: "nope", status: 0, signal: null, revision: "rerun-revision", runId: "other-run", runAttempt: "9" }));
  assert.notEqual(gate2().status, 0, "foreign runId receipt fails closed");
});

test("canonical suite partition is complete and deterministic with bounded timing estimates", () => {
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:browser"];
  const plan = browserPlan(script);
  assert.deepEqual(browserPlan(script), plan);
  assert.deepEqual(plan.shards.flatMap(shard => shard.files).sort(), plan.files.toSorted());
  assert.equal(new Set(plan.shards.flatMap(shard => shard.files)).size, plan.files.length);
  for (const shard of plan.shards) assert.ok(shard.files.length > 0 && shard.estimatedMs > 0);
  assert.throws(() => browserPlan("node --test scripts/a.mjs scripts/a.mjs"), /unique/);
  assert.throws(() => browserPlan("node --test scripts/*.mjs"), /explicit/);
  assert.throws(() => parseShard("1/4 trailing"), /Shard/);
});

test("browser shard plan is balanced on measured runtimes: full timing coverage, no shard over 30%", () => {
  // The browser leg is the slowest CI leg and its wall time is the slowest
  // shard. Balance is only real when every suite file carries measured timing
  // data: an unmeasured file falls back to a 10s guess and the greedy
  // partition optimizes fiction (28 of 123 files were unmeasured, and the two
  // slowest measured shards ran ~1.5x their estimate).
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:browser"];
  const measured = JSON.parse(readFileSync("scripts/browser-ci-durations.json", "utf8")).milliseconds;
  const plan = browserPlan(script);
  const unmeasured = plan.files.filter(file => !(Number.isFinite(measured[file]) && measured[file] > 0));
  assert.deepEqual(unmeasured, [], `browser shard balance needs measured durations for: ${unmeasured.join(", ")}`);
  const total = plan.shards.reduce((sum, shard) => sum + shard.estimatedMs, 0);
  for (const shard of plan.shards) {
    const share = shard.estimatedMs / total;
    assert.ok(share <= 0.30, `browser shard ${shard.index} holds ${(100 * share).toFixed(1)}% of measured runtime (cap 30%)`);
  }
});
