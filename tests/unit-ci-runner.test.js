import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runTestFiles, receiptFailures } from "../scripts/unit-ci.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", "unit-ci", name);

test("runTestFiles returns status 0 and no failures when all pass", () => {
  const { status, signal, failures } = runTestFiles([fixture("pass-probe.mjs")]);
  assert.equal(status, 0);
  assert.equal(signal, null);
  assert.deepEqual(failures, []);
});

test("runTestFiles names the failing test on a red run", () => {
  const { status, failures } = runTestFiles([
    fixture("pass-probe.mjs"),
    fixture("fail-probe.mjs"),
  ]);
  assert.notEqual(status, 0);
  assert.ok(
    failures.some((f) => f.includes("probe fails deterministically")),
    `expected the failing probe name, got: ${JSON.stringify(failures)}`
  );
});

test("receipt failures omit the deliberate fail-probe fixture (issue #4261)", () => {
  const { status, failures } = runTestFiles([
    fixture("pass-probe.mjs"),
    fixture("fail-probe.mjs"),
  ]);
  assert.notEqual(status, 0);
  // The runner's own view stays unfiltered (asserted above); the receipt
  // view — receiptFailures, applied at receipt write in main — must not
  // list the on-purpose fixture as a shard failure, and must keep any
  // real failure name untouched.
  assert.deepEqual(receiptFailures(failures), []);
  assert.deepEqual(
    receiptFailures(["a real failure", "probe fails deterministically"]),
    ["a real failure"]
  );
});
