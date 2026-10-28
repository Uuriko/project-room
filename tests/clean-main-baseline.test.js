import test from "node:test";
import assert from "node:assert/strict";
import { diffFailures, parseArgs, parseTapFailures } from "../scripts/clean-main-baseline.mjs";

const TAP = `TAP version 13
# Subtest: ok one
ok 1 - ok one
# Subtest: group
    # Subtest: inner fail
    not ok 1 - inner fail
      ---
      error: 'Expected values to be strictly equal'
      ...
    # Subtest: inner ok
    ok 2 - inner ok
    # Subtest: inner skip
    not ok 3 - inner skip # SKIP not here
    1..3
not ok 2 - group
# Subtest: b fails
not ok 3 - b fails
1..3
# tests 5
# fail 2
`;

test("parseTapFailures keeps failing leaves once and ignores skips", () => {
  assert.deepEqual(parseTapFailures(TAP), ["b fails", "group > inner fail"]);
});

test("parseTapFailures returns nothing for a clean run", () => {
  assert.deepEqual(parseTapFailures("TAP version 13\n# Subtest: a\nok 1 - a\n1..1\n"), []);
});

test("diffFailures separates introduced, fixed and persistent failures", () => {
  const d = diffFailures(["a", "b"], ["b", "c"]);
  assert.deepEqual(d, { introduced: ["c"], fixed: ["a"], persistent: ["b"] });
});

test("parseArgs reads refs, options and test files", () => {
  const o = parseArgs(["--base", "main", "--head", "fo/x", "--concurrency", "2", "--json", "r.json", "tests/a.test.js"]);
  assert.equal(o.base, "main");
  assert.equal(o.head, "fo/x");
  assert.equal(o.concurrency, 2);
  assert.equal(o.json, "r.json");
  assert.deepEqual(o.files, ["tests/a.test.js"]);
});
