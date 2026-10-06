import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { unitPlan, parseShard, verifyUnitShards, SHARD_COUNT } from "../scripts/unit-shards.mjs";

// Real Node tests, real wrapper and real gate: covers omission/duplication,
// lost child exit codes, missing matrix jobs and stale success artifacts.
// The unit gate must never silently drop a test file: a shard plan that
// loses coverage weakens the merge gate it is supposed to speed up.
test("unit shards execute each test file once and aggregate only complete current success", t => {
  const dir = mkdtempSync(join(tmpdir(), "unit-shards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "tests"));
  for (const name of ["unit-ci.mjs", "unit-ci-durations.json", "unit-shards.mjs", "unit-shards-check.mjs"]) {
    cpSync(join("scripts", name), join(dir, "scripts", name));
  }
  // Fixture durations: 9 files with known weights; the planner under test
  // reads the copied scripts/unit-ci-durations.json, so seed it deterministically.
  const files = Array.from({ length: 9 }, (_, i) => `tests/check-${i}.test.js`);
  const durations = Object.fromEntries(files.map((f, i) => [f, (i + 1) * 1000]));
  writeFileSync(join(dir, "scripts/unit-ci-durations.json"), JSON.stringify({ milliseconds: durations }));
  for (const [i, file] of files.entries()) {
    writeFileSync(join(dir, file), `import test from 'node:test'; import { appendFileSync } from 'node:fs'; test('unit case ${i}', () => { appendFileSync('executed.txt', '${i}\\n'); if (process.env.FAIL_CASE === '${i}') throw new Error('intentional child failure'); });\n`);
  }
  const env = { ...process.env, GITHUB_SHA: "fixture-revision", GITHUB_RUN_ID: "fixture-run", GITHUB_RUN_ATTEMPT: "1", UNIT_MATRIX_RESULT: "success" };
  delete env.NODE_TEST_CONTEXT; // The fixture launches an independent test runner, not a nested test file.
  const invoke = (file, args = [], more = {}) => spawnSync(process.execPath, [file, ...args], { cwd: dir, env: { ...env, ...more }, encoding: "utf8", timeout: 30000 });
  for (const invalid of ["--shard=0/3", "--shard=4/3", "--shard=1/0", "--shard=1/4", "--shard=NaN/3", "--unknown"]) {
    assert.notEqual(invoke("scripts/unit-ci.mjs", [invalid]).status, 0, invalid);
  }
  for (let index = 1; index <= SHARD_COUNT; index++) {
    const run = invoke("scripts/unit-ci.mjs", [`--shard=${index}/${SHARD_COUNT}`]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`unit-ci: shard ${index}/${SHARD_COUNT}`));
  }
  assert.deepEqual(readFileSync(join(dir, "executed.txt"), "utf8").trim().split("\n").map(Number).sort((a, b) => a - b), [...files.keys()]);
  const gate = (more = {}) => invoke("scripts/unit-shards-check.mjs", ["test-results"], more);
  assert.equal(gate().status, 0);
  for (const state of ["failure", "cancelled", "skipped", ""]) assert.notEqual(gate({ UNIT_MATRIX_RESULT: state }).status, 0, state);
  assert.notEqual(gate({ GITHUB_SHA: "different-revision" }).status, 0);
  assert.equal(gate({ GITHUB_RUN_ATTEMPT: "2" }).status, 0, "earlier-attempt receipts accepted by a re-run aggregator");
  const receiptPath = join(dir, `test-results/unit-shard-${SHARD_COUNT}-of-${SHARD_COUNT}-attempt-1.json`);
  const receipt = readFileSync(receiptPath, "utf8");
  rmSync(receiptPath);
  assert.notEqual(gate().status, 0, "missing successful shard fails closed");
  writeFileSync(receiptPath, receipt);
  const altered = JSON.parse(receipt);
  altered.files.pop();
  writeFileSync(receiptPath, JSON.stringify(altered));
  assert.notEqual(gate().status, 0, "omitted file fails closed");
  writeFileSync(receiptPath, receipt);
});

test("unit shard plan is complete, deterministic, and balanced on measured runtimes", () => {
  const plan = unitPlan("tests");
  assert.deepEqual(unitPlan("tests"), plan, "plan is deterministic");
  assert.deepEqual(plan.shards.flatMap((shard) => shard.files).sort(), plan.files.toSorted());
  assert.equal(new Set(plan.shards.flatMap((shard) => shard.files)).size, plan.files.length);
  for (const shard of plan.shards) assert.ok(shard.files.length > 0 && shard.estimatedMs > 0);
  assert.throws(() => parseShard("1/4 trailing"), /Shard/);
  assert.throws(() => parseShard(`2/${SHARD_COUNT + 1}`), /Shard/);
  // Balance is only real when every suite file carries measured timing data.
  const measured = JSON.parse(readFileSync("scripts/unit-ci-durations.json", "utf8")).milliseconds;
  const unmeasured = plan.files.filter((file) => !(Number.isFinite(measured[file]) && measured[file] > 0));
  assert.deepEqual(unmeasured, [], `unit shard balance needs measured durations for: ${unmeasured.join(", ")}`);
  const total = plan.shards.reduce((sum, shard) => sum + shard.estimatedMs, 0);
  for (const shard of plan.shards) {
    const share = shard.estimatedMs / total;
    assert.ok(share <= 0.4, `unit shard ${shard.index} holds ${(100 * share).toFixed(1)}% of measured runtime (cap 40%)`);
  }
});

test("verifyUnitShards rejects tampered, missing, and cross-run receipts", () => {
  const plan = unitPlan("tests");
  const ident = { matrixResult: "success", revision: "r", runId: "1", runAttempt: "1" };
  const good = plan.shards.map((s) => ({
    index: s.index, total: SHARD_COUNT, files: s.files, planHash: plan.planHash,
    status: 0, signal: null, revision: "r", runId: "1", runAttempt: "1",
  }));
  assert.deepEqual(verifyUnitShards(plan, good, ident), { files: plan.files.length, shards: SHARD_COUNT });
  const tampered = structuredClone(good);
  tampered[0].files = tampered[0].files.slice(1);
  assert.throws(() => verifyUnitShards(plan, tampered, ident), /mismatched evidence/);
  assert.throws(() => verifyUnitShards(plan, good.slice(0, SHARD_COUNT - 1), ident), /Missing or duplicate/);
  const foreign = structuredClone(good);
  foreign[0].runId = "other-run";
  assert.throws(() => verifyUnitShards(plan, foreign, ident), /mismatched evidence/);
  assert.throws(() => verifyUnitShards(plan, good, { ...ident, matrixResult: "failure" }), /did not succeed/);
});
