// Fail-first tests for scripts/invariants-ci.mjs (the invariant CI gate producer).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isMainModule,
  invariantName,
  isFileLevelTest,
  parseTap,
  applyRunnerExitGuard,
  buildRunStart,
  buildRunEnd,
  renderMarkdown,
} from "../scripts/invariants-ci.mjs";

test("invariantName extracts the kebab id from scenario test names", () => {
  assert.equal(invariantName("invariant release-requires-holder: only the claim holder can release it"), "release-requires-holder");
  assert.equal(invariantName("invariant smoke-refusal: refusal capture"), "smoke-refusal");
});

test("invariantName slugifies non-invariant harness self-tests", () => {
  assert.equal(invariantName("dsl: when() captures a refusal into ctx.error for then()"), "dsl-when-captures-a-refusal-into-ctx-error-for-then");
});

test("isFileLevelTest skips per-file aggregate lines", () => {
  assert.equal(isFileLevelTest("/repo/tests/invariants/harness-smoke.test.mjs"), true);
  assert.equal(isFileLevelTest("test at tests/invariants/harness-smoke.test.mjs:1:1"), true);
  assert.equal(isFileLevelTest("invariant smoke-link: link helper semantics"), false);
});

test("parseTap records nested invariant tests with durations and skips file aggregates", () => {
  const tap = `TAP version 13
# Subtest: dsl: builder captures declare/act/assert phases in order
ok 1 - dsl: builder captures declare/act/assert phases in order
  ---
  duration_ms: 41.304295
  type: 'test'
  ...
# Subtest: runner: each scenario boots an isolated disposable database
    # Subtest: invariant smoke-isolation: db isolation
    ok 1 - invariant smoke-isolation: db isolation
      ---
      duration_ms: 2494.557
      type: 'test'
      ...
    1..1
ok 2 - runner: each scenario boots an isolated disposable database
  ---
  duration_ms: 2518.75
  type: 'test'
  ...
1..2
`;
  const { records, bailOut } = parseTap(tap);
  assert.equal(bailOut, null);
  assert.equal(records.length, 3);
  assert.equal(records[0].name, "dsl-builder-captures-declare-act-assert-phases-in-order");
  assert.equal(records[0].status, "pass");
  assert.equal(records[0].duration_ms, 41);
  assert.equal(records[1].name, "smoke-isolation");
  assert.equal(records[1].status, "pass");
  assert.equal(records[1].duration_ms, 2495);
  assert.equal(records[2].name, "runner-each-scenario-boots-an-isolated-disposable-database");
  assert.equal(records[2].duration_ms, 2519);
});

test("parseTap marks not-ok tests as fail with the failure type", () => {
  const tap = `TAP version 13
    # Subtest: invariant retry-idempotent: retry must not duplicate work
    not ok 1 - invariant retry-idempotent: retry must not duplicate work
      ---
      duration_ms: 12.5
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal: 2 !== 1
      ...
    1..1
not ok 1 - /repo/tests/invariants/retry.test.mjs
  ---
  duration_ms: 30.1
  ...
1..1
`;
  const { records } = parseTap(tap);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "retry-idempotent");
  assert.equal(records[0].status, "fail");
  assert.match(records[0].message, /testCodeFailure/);
  assert.match(records[0].message, /strictly equal/);
});

test("parseTap captures the plain-Error single-line error form with code and stack (#4262)", () => {
  // Shape executed from Node v24's TAP reporter for a test body that throws
  // a plain Error (e.g. the fixture boot exploding): the error arrives as a
  // single-line quoted scalar, NOT the |- block an AssertionError gets. The
  // old parser dropped it, recording a bare "testCodeFailure".
  const tap = `TAP version 13
# Subtest: invariant boot-death: fixture boot throws instantly
not ok 1 - invariant boot-death: fixture boot throws instantly
  ---
  duration_ms: 0.4821
  type: 'test'
  location: '/repo/tests/invariants/boot-death.test.mjs:7:1'
  failureType: 'testCodeFailure'
  error: 'fixture boot exploded: simulated EPERM opening store'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    boot (file:///repo/tests/invariants/boot-death.test.mjs:5:25)
    TestContext.<anonymous> (file:///repo/tests/invariants/boot-death.test.mjs:8:13)
  ...
1..1
`;
  const { records } = parseTap(tap);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "boot-death");
  assert.equal(records[0].status, "fail");
  assert.match(records[0].message, /testCodeFailure/);
  assert.match(records[0].message, /fixture boot exploded: simulated EPERM opening store/);
  assert.equal(records[0].error_code, "ERR_TEST_FAILURE");
  assert.match(records[0].stack, /boot \(file:/);
});

test("parseTap names a file-level load death with diagnostics and exit code (#4262)", () => {
  // Shape executed from Node v24: a file whose module graph throws at load
  // prints its real error as `#` diagnostics, then aggregates `not ok` with
  // exitCode in the YAML and only the generic 'test failed' as its error.
  const tap = `TAP version 13
# file:///repo/tests/invariants/load-death.test.mjs:3
# throw new Error("simulated module load failure");
#       ^
# Error: simulated module load failure
#     at file:///repo/tests/invariants/load-death.test.mjs:3:7
#     at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
# Node.js v24.20.0
# Subtest: /repo/tests/invariants/load-death.test.mjs
not ok 1 - /repo/tests/invariants/load-death.test.mjs
  ---
  duration_ms: 317.204485
  type: 'test'
  location: '/repo/tests/invariants/load-death.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: /repo/tests/invariants/healthy.test.mjs
    # Subtest: invariant healthy-one: passes
    ok 1 - invariant healthy-one: passes
      ---
      duration_ms: 12.0
      type: 'test'
      ...
    1..1
ok 2 - /repo/tests/invariants/healthy.test.mjs
  ---
  duration_ms: 40.0
  type: 'test'
  ...
1..2
`;
  const { records } = parseTap(tap);
  assert.equal(records.length, 2);
  const death = records.find(r => r.name === "file:load-death.test.mjs");
  assert.ok(death, "load death is a named record");
  assert.equal(death.status, "error");
  assert.match(death.message, /exit 1/);
  assert.match(death.message, /Error: simulated module load failure/);
  assert.equal(death.exit_code, 1);
  assert.match(death.stack, /at file:/);
  const healthy = records.find(r => r.name === "healthy-one");
  assert.ok(healthy, "the healthy file's test is recorded");
  assert.equal(healthy.status, "pass");
});

test("parseTap does not double-report a file whose named test failed (#4262)", () => {
  // A file containing a failing test also aggregates `not ok`; the failure
  // already has its own record, so no file: record may be synthesized.
  const tap = `TAP version 13
# Subtest: /repo/tests/invariants/retry.test.mjs
    # Subtest: invariant retry-idempotent: retry must not duplicate work
    not ok 1 - invariant retry-idempotent: retry must not duplicate work
      ---
      duration_ms: 12.5
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal: 2 !== 1
      code: 'ERR_ASSERTION'
      ...
    1..1
not ok 1 - /repo/tests/invariants/retry.test.mjs
  ---
  duration_ms: 30.1
  failureType: 'testCodeFailure'
  exitCode: 1
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
`;
  const { records } = parseTap(tap);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "retry-idempotent");
  assert.equal(records[0].error_code, "ERR_ASSERTION");
});

test("parseTap records skips and bail-outs", () => {
  const { records } = parseTap("    ok 1 - invariant slow-flaky: maybe later # SKIP not tonight\n");
  assert.equal(records[0].status, "skip");
  const { bailOut } = parseTap("Bail out! database locked\n");
  assert.match(bailOut, /database locked/);
});

test("buildRunEnd fails closed on any fail and computes counts", () => {
  const runId = "inv_1_ab12cd";
  const startedAt = new Date(Date.now() - 5000).toISOString();
  const end = buildRunEnd({
    runId,
    sha: "abc123",
    startedAt,
    records: [
      { status: "pass", duration_ms: 1 },
      { status: "fail", duration_ms: 2 },
      { status: "skip", duration_ms: 0 },
    ],
    bailOut: null,
  });
  assert.equal(end.type, "run_end");
  assert.equal(end.status, "fail");
  assert.deepEqual(end.counts, { pass: 1, fail: 1, skip: 1, error: 0 });
  assert.ok(end.duration_ms >= 0);
  assert.equal(buildRunStart({ runId, sha: "abc123" }).type, "run_start");
});

test("applyRunnerExitGuard fails closed when the runner dies but records pass", () => {
  const recs = [{ status: "pass", duration_ms: 1 }];
  applyRunnerExitGuard(recs, 1, 500, new Date().toISOString());
  assert.equal(recs.length, 2);
  assert.equal(recs[1].name, "harness-runner");
  assert.equal(recs[1].status, "error");
  assert.match(recs[1].message, /exited 1/);
  const ok = [{ status: "pass" }];
  applyRunnerExitGuard(ok, 0, 1, "");
  assert.equal(ok.length, 1);
});

test("gate actually runs when the checkout path contains spaces", { timeout: 30000 }, () => {
  // Regression for #2886: the gate compared argv[1] against the raw,
  // percent-encoded URL pathname, so in a checkout whose path contains a
  // space the main-module check never matched, runGate() was never invoked,
  // and the script silently exited 0 having run no tests.
  const root = mkdtempSync(join(tmpdir(), "invariants ci gate-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "tests", "invariants"), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("../scripts/invariants-ci.mjs", import.meta.url)),
      join(root, "scripts", "invariants-ci.mjs"),
    );
    writeFileSync(
      join(root, "tests", "invariants", "smoke.test.mjs"),
      'import test from "node:test";\ntest("invariant smoke-space: dummy passes", () => {});\n',
    );
    // Spawn the gate the way CI does, as a standalone process: drop the test
    // runner's context markers, which would make the gate's own nested
    // `node --test` refuse to run any files ("run() called recursively").
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const proc = spawnSync(process.execPath, [join(root, "scripts", "invariants-ci.mjs")], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(proc.status, 0, proc.stdout + proc.stderr);
    assert.match(proc.stdout, /invariants: PASS/);
    const results = readFileSync(join(root, "results", "invariants.jsonl"), "utf8");
    assert.match(results, /"type":\s*"run_start"/);
    assert.match(results, /"name":\s*"smoke-space"/);
    assert.match(results, /"type":\s*"run_end"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate records plain-Error and load-death failures with their error text, and keeps the raw TAP (#4262)", { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "invariants-gate-evidence-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "tests", "invariants"), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("../scripts/invariants-ci.mjs", import.meta.url)),
      join(root, "scripts", "invariants-ci.mjs"),
    );
    writeFileSync(
      join(root, "tests", "invariants", "boot-death.test.mjs"),
      'import test from "node:test";\ntest("invariant boot-death: fixture boot throws instantly", () => { throw new Error("fixture boot exploded: simulated EPERM opening store"); });\n',
    );
    writeFileSync(
      join(root, "tests", "invariants", "load-death.test.mjs"),
      'throw new Error("simulated module load failure");\n',
    );
    writeFileSync(
      join(root, "tests", "invariants", "healthy.test.mjs"),
      'import test from "node:test";\ntest("invariant healthy-one: passes", () => {});\n',
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const proc = spawnSync(process.execPath, [join(root, "scripts", "invariants-ci.mjs")], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(proc.status, 1, proc.stdout + proc.stderr);
    assert.match(proc.stdout, /invariants: FAIL/);
    const results = readFileSync(join(root, "results", "invariants.jsonl"), "utf8");
    const lines = results.trim().split("\n").map(l => JSON.parse(l));
    const recs = lines.filter(l => l.type === "invariant_result");
    const boot = recs.find(r => r.name === "boot-death");
    assert.ok(boot, "boot-throw test is a named record");
    assert.equal(boot.status, "fail");
    assert.match(boot.message, /fixture boot exploded: simulated EPERM opening store/);
    assert.equal(boot.error_code, "ERR_TEST_FAILURE");
    const death = recs.find(r => r.name === "file:load-death.test.mjs");
    assert.ok(death, "load death is a named file: record");
    assert.equal(death.status, "error");
    assert.equal(death.exit_code, 1);
    assert.match(death.message, /simulated module load failure/);
    assert.ok(recs.some(r => r.name === "healthy-one" && r.status === "pass"));
    const end = lines.find(l => l.type === "run_end");
    assert.equal(end.status, "fail");
    // The raw TAP stream is preserved beside the results file.
    const tapPath = join(root, "results", "invariants.tap");
    assert.ok(existsSync(tapPath), "raw TAP file written");
    const tap = readFileSync(tapPath, "utf8");
    assert.match(tap, /not ok/);
    assert.match(tap, /simulated module load failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderMarkdown renders the table with the gate marker", () => {
  const startedAt = new Date().toISOString();
  const records = [{ name: "smoke-link", status: "pass", duration_ms: 10, message: "" }];
  const runEnd = buildRunEnd({ runId: "inv_1_x", sha: "deadbeef", startedAt, records, bailOut: null });
  const md = renderMarkdown({ runId: "inv_1_x", sha: "deadbeef", startedAt, records, runEnd });
  assert.match(md, /<!-- invariants-ci -->/);
  assert.match(md, /\| `smoke-link` \| ✅ pass \| 10ms \|/);
  assert.match(md, /## Invariant harness — PASS/);
});


test("main-module detection follows a real symlink without treating a different file as main", () => {
  const root = mkdtempSync(join(tmpdir(), "invariant-main-link-"));
  try {
    const actual = join(root, "actual.mjs"), alias = join(root, "alias.mjs"), other = join(root, "other.mjs");
    writeFileSync(actual, ""); writeFileSync(other, ""); symlinkSync(actual, alias);
    assert.equal(isMainModule(alias, pathToFileURL(actual).href), true);
    assert.equal(isMainModule(other, pathToFileURL(actual).href), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
