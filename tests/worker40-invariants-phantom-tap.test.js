// WORKER-40 (guild-06 shard 40): parseTap must not emit phantom invariant
// records for TAP-looking lines nested inside a test's YAML detail block.
// Repro: an assertion diff that quotes TAP output inside `error: |-` produced
// a second, bogus `fail` record ("expected-tap-line") with no corresponding
// test — polluting results/invariants.jsonl and the PR comment table.
import test from "node:test";
import assert from "node:assert/strict";
import { parseTap } from "../scripts/invariants-ci.mjs";

const PHANTOM_TAP = `TAP version 13
    # Subtest: invariant real-one: the real test
    not ok 1 - invariant real-one: the real test
      ---
      duration_ms: 5
      failureType: 'testCodeFailure'
      error: |-
        diff:
        not ok 2 - expected tap line
        end of diff
      ...
    1..1
not ok 1 - /repo/tests/invariants/one.test.mjs
  ---
  duration_ms: 30.1
  ...
1..1
`;

test("parseTap ignores TAP-looking lines inside YAML detail blocks", () => {
  const { records, bailOut } = parseTap(PHANTOM_TAP);
  assert.equal(bailOut, null);
  assert.equal(records.length, 1, `expected exactly the real test, got: ${records.map(r => r.name).join(", ")}`);
  assert.equal(records[0].name, "real-one");
  assert.equal(records[0].status, "fail");
});

test("parseTap still records tests whose detail blocks end at end-of-input", () => {
  const tap = `TAP version 13
ok 1 - invariant tail-test: last one
  ---
  duration_ms: 3
  ...
`;
  const { records } = parseTap(tap);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "tail-test");
  assert.equal(records[0].status, "pass");
});

test("parseTap still records a test with no detail block at all", () => {
  const { records } = parseTap("TAP version 13\nok 1 - invariant bare: no block\n");
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "bare");
  assert.equal(records[0].status, "pass");
});
