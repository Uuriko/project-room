// Fail-first tests for scripts/invariants-ci.mjs (the invariant CI gate producer).
import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("renderMarkdown renders the table with the gate marker", () => {
  const startedAt = new Date().toISOString();
  const records = [{ name: "smoke-link", status: "pass", duration_ms: 10, message: "" }];
  const runEnd = buildRunEnd({ runId: "inv_1_x", sha: "deadbeef", startedAt, records, bailOut: null });
  const md = renderMarkdown({ runId: "inv_1_x", sha: "deadbeef", startedAt, records, runEnd });
  assert.match(md, /<!-- invariants-ci -->/);
  assert.match(md, /\| `smoke-link` \| ✅ pass \| 10ms \|/);
  assert.match(md, /## Invariant harness — PASS/);
});
