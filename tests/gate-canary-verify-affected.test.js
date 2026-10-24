// Gate canary for the test-selection pair (#3681 tranche T2):
// scripts/verify-affected.mjs (selection) and scripts/unit-shards-check.mjs
// (the required-status roll-up over shard receipts).
//
// Both gates run as subprocesses inside fixture git repos / receipt trees
// under a spaced path (the gates are copied into the fixture in their real
// layout, the browser-shards.test.js precedent). Must-fail runs assert a
// non-zero exit AND that the output names the target; controls assert
// zero. Zero-target cases: an empty diff must still select the smoke set
// (selection is never empty), and an empty receipt directory must fail
// the roll-up, never pass it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_TESTS } from "../scripts/verify-affected.mjs";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));

function run(script, args, cwd, env = {}) {
  const fullEnv = { ...process.env, ...env };
  delete fullEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [script, ...args], { cwd, env: fullEnv, encoding: "utf8", timeout: 120000 });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitAll(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.email=canary@example.invalid", "-c", "user.name=gate-canary", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
}

const TRIVIAL_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'test("fixture case", () => { assert.ok(true); });',
  "",
].join("\n");

// ---------------------------------------------------------------------
// verify-affected selection
// ---------------------------------------------------------------------

function verifyFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "gate canary verify affected-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  for (const name of ["verify-affected.mjs", "unit-shards.mjs", "unit-ci-durations.json"])
    cpSync(join(SCRIPTS, name), join(dir, "scripts", name));
  writeFileSync(join(dir, "canary-module.mjs"), "export const value = 1;\n");
  writeFileSync(join(dir, "orphan-module.mjs"), "export const orphan = 1;\n");
  writeFileSync(join(dir, "tests", "canary-target.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { value } from "../canary-module.mjs";',
    'test("canary target", () => { assert.equal(value, 1); });',
    "",
  ].join("\n"));
  for (const smoke of SMOKE_TESTS) {
    mkdirSync(join(dir, smoke, ".."), { recursive: true });
    writeFileSync(join(dir, smoke), TRIVIAL_TEST);
  }
  git(dir, ["init", "-q", "-b", "main"]);
  commitAll(dir, "fixture base");
  return dir;
}

function runVerify(dir) {
  return run(join(dir, "scripts", "verify-affected.mjs"), ["--list", "--base=HEAD"], dir);
}

test("canary: a changed module selects the test that imports it, by name", (t) => {
  const dir = verifyFixture(t);
  appendFileSync(join(dir, "canary-module.mjs"), "// canary change\n");
  const result = runVerify(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 changed file\(s\)/);
  assert.match(result.stdout, /tests\/canary-target\.test\.js/);
});

test("canary: a changed orphan module falls back to the smoke set, never an empty selection", (t) => {
  const dir = verifyFixture(t);
  appendFileSync(join(dir, "orphan-module.mjs"), "// canary change\n");
  const result = runVerify(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /smoke set: no related test for orphan-module\.mjs/);
  assert.match(result.stdout, /tests\/events\.test\.js/);
});

test("canary: an empty diff still selects the smoke set", (t) => {
  const dir = verifyFixture(t);
  const result = runVerify(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 changed file\(s\)/);
  assert.match(result.stdout, /smoke set: no changes/);
  assert.match(result.stdout, /tests\/events\.test\.js/);
});

// ---------------------------------------------------------------------
// unit-shards-check roll-up
// ---------------------------------------------------------------------

function shardsFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "gate canary unit shards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  mkdirSync(join(dir, "receipts"), { recursive: true });
  for (const name of ["unit-shards.mjs", "unit-shards-check.mjs", "unit-ci-durations.json"])
    cpSync(join(SCRIPTS, name), join(dir, "scripts", name));
  for (const name of ["a.test.js", "b.test.js", "c.test.js"])
    writeFileSync(join(dir, "tests", name), TRIVIAL_TEST);
  writeFileSync(join(dir, "gen-receipts.mjs"), [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { unitPlan, SHARD_COUNT } from "./scripts/unit-shards.mjs";',
    "const plan = unitPlan('.');",
    'mkdirSync("receipts", { recursive: true });',
    "for (const shard of plan.shards) {",
    '  writeFileSync(`receipts/unit-shard-${shard.index}.json`, JSON.stringify({',
    "    index: shard.index, total: SHARD_COUNT, status: 0, signal: null,",
    "    planHash: plan.planHash, revision: 'canary-rev', runId: 'canary-run',",
    "    runAttempt: '1', files: shard.files,",
    "  }));",
    "}",
    "",
  ].join("\n"));
  const gen = run(join(dir, "gen-receipts.mjs"), [], dir);
  assert.equal(gen.status, 0, gen.stdout + gen.stderr);
  return dir;
}

const CHECK_ENV = {
  UNIT_MATRIX_RESULT: "success",
  GITHUB_SHA: "canary-rev",
  GITHUB_RUN_ID: "canary-run",
  GITHUB_RUN_ATTEMPT: "1",
};

function runCheck(dir, receiptsDir) {
  return run(join(dir, "scripts", "unit-shards-check.mjs"), [receiptsDir], dir, CHECK_ENV);
}

test("canary: complete shard receipts pass the roll-up; a failed shard and empty evidence fail it", (t) => {
  const dir = shardsFixture(t);
  const receipts = join(dir, "receipts");

  const ok = runCheck(dir, receipts);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /all 3 shards succeeded; 3 test files covered exactly once/);

  const receiptPath = join(receipts, "unit-shard-2.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.status = 1;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const tampered = runCheck(dir, receipts);
  assert.notEqual(tampered.status, 0, "a failed shard must fail the roll-up");
  assert.match(tampered.stdout + tampered.stderr, /Unit shard 2/);

  const emptyDir = join(dir, "receipts empty");
  mkdirSync(emptyDir);
  const empty = runCheck(dir, emptyDir);
  assert.notEqual(empty.status, 0, "zero receipts must fail the roll-up, not pass it");
  assert.match(empty.stdout + empty.stderr, /Missing unit shard receipts/);
});
