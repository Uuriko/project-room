import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runTestFiles, unitTestConcurrency } from "../scripts/unit-ci.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", "unit-ci", name);

test("runTestFiles returns status 0 and no failures when all pass", () => {
  const { status, signal, failures } = runTestFiles([fixture("pass-probe.mjs")]);
  assert.equal(status, 0);
  assert.equal(signal, null);
  assert.deepEqual(failures, []);
});

test("unitTestConcurrency oversubscribes the CPU count 2x (PERF-50 G4)", () => {
  assert.equal(unitTestConcurrency(1), 2);
  assert.equal(unitTestConcurrency(2), 4);
  assert.equal(unitTestConcurrency(4), 8);
  // Degenerate inputs still yield a runnable positive concurrency.
  assert.equal(unitTestConcurrency(0), 2);
  assert.equal(unitTestConcurrency(Number.NaN), 2);
});

test("runTestFiles runs at 2x-CPU concurrency by default and honours an override", () => {
  const byDefault = runTestFiles([fixture("pass-probe.mjs")]);
  assert.equal(byDefault.status, 0);
  assert.equal(byDefault.testConcurrency, unitTestConcurrency());
  const overridden = runTestFiles([fixture("pass-probe.mjs")], { testConcurrency: 1 });
  assert.equal(overridden.status, 0);
  assert.equal(overridden.testConcurrency, 1);
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
