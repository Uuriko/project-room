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

test("receipt failures omit the deliberate fail-probe fixture but keep real failures", () => {
  // A real run that executed the fail-probe fixture: the raw parse lists the
  // probe (asserted above), but the receipt main() writes must not (#4261).
  const { status, failures } = runTestFiles([
    fixture("pass-probe.mjs"),
    fixture("fail-probe.mjs"),
  ]);
  assert.notEqual(status, 0);
  assert.deepEqual(receiptFailures(failures), []);
  assert.deepEqual(
    receiptFailures([...failures, "some real failure"]),
    ["some real failure"],
    "real failure names survive the receipt filter"
  );
});
