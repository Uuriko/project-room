// Regression for #2902: runChecker must not convert a signal-killed checker
// into exit code 0. These tests are fast and are NOT gated on QA2_E2E.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, checkerOutcome, runChecker } from "./helpers.js";

test("checkerOutcome: success, numeric codes, spawn errors, and signals are truthful", () => {
  assert.deepEqual(checkerOutcome(null), { code: 0, signal: null });
  assert.deepEqual(checkerOutcome({ code: 3 }), { code: 3, signal: null });
  // Spawn failures carry a string code (e.g. ENOENT): still a failure, never 0.
  assert.notEqual(checkerOutcome({ code: "ENOENT" }).code, 0);
  // Signal termination carries code=null and signal set: never success.
  const killed = checkerOutcome({ code: null, signal: "SIGKILL" });
  assert.equal(killed.signal, "SIGKILL");
  assert.notEqual(killed.code, 0);
  assert.equal(killed.code, 137); // 128 + SIGKILL(9), the shell convention
  assert.equal(checkerOutcome({ code: null, signal: "SIGTERM" }).code, 143);
});

test("runChecker: a SIGKILLed checker reports a nonzero code and its signal", async () => {
  const name = `run-checker-signal-fixture-${process.pid}.mjs`;
  const path = join(ROOT, "scripts/qa2", name);
  writeFileSync(path, 'process.kill(process.pid, "SIGKILL");\n');
  try {
    const { code, signal } = await runChecker(name, []);
    assert.equal(signal, "SIGKILL");
    assert.notEqual(code, 0, "a signal-killed checker must not be reported as success");
    assert.equal(code, 137);
  } finally { rmSync(path, { force: true }); }
});

test("runChecker: a checker exiting nonzero keeps its code, one exiting 0 stays 0", async () => {
  const failName = `run-checker-exit3-fixture-${process.pid}.mjs`;
  const okName = `run-checker-exit0-fixture-${process.pid}.mjs`;
  const failPath = join(ROOT, "scripts/qa2", failName);
  const okPath = join(ROOT, "scripts/qa2", okName);
  writeFileSync(failPath, "process.exit(3);\n");
  writeFileSync(okPath, "process.exit(0);\n");
  try {
    const failed = await runChecker(failName, []);
    assert.equal(failed.code, 3);
    assert.equal(failed.signal, null);
    const ok = await runChecker(okName, []);
    assert.equal(ok.code, 0);
    assert.equal(ok.signal, null);
  } finally { rmSync(failPath, { force: true }); rmSync(okPath, { force: true }); }
});
