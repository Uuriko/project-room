/**
 * tests/quarantine-check.test.js
 *
 * Pins the F-28 fix in scripts/quarantine-check.mjs (under #3673):
 *  - an entry naming a test file that does not exist fails the gate
 *    (before the fix, a renamed test left a dead entry that passed);
 *  - the empty list passes, and the run prints the zero-count canary
 *    line proving the existence predicate can still fail;
 *  - a live entry within contract passes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "quarantine-check.mjs");

function runCheck(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "quarantine-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "live.test.js"), "import test from 'node:test';\n");
  const jsonPath = join(dir, "tests", "quarantine.json");
  writeFileSync(jsonPath, JSON.stringify({ quarantined: entries }));
  // The checker resolves entry files relative to the repo root it infers
  // from the json path's directory's parent.
  return spawnSync(process.execPath, [SCRIPT, jsonPath], { encoding: "utf8" });
}

const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const liveEntry = {
  test: "tests/live.test.js",
  reason: "flaky: timing race in fixture setup",
  owner: "qa",
  quarantined_at: isoDay(0),
  repair_by: isoDay(10),
};

test("empty quarantine passes and prints the zero-count canary", (t) => {
  const result = runCheck(t, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /canary/i);
});

test("entry naming a missing test file fails (F-28 existence check)", (t) => {
  const result = runCheck(t, [{ ...liveEntry, test: "tests/renamed-away.test.js" }]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /does not exist/);
});

test("entry naming a live test file passes", (t) => {
  const result = runCheck(t, [liveEntry]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("entry in 'file > test name' form checks the file part", (t) => {
  const ok = runCheck(t, [{ ...liveEntry, test: "tests/live.test.js > a flaky case" }]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = runCheck(t, [{ ...liveEntry, test: "tests/gone.test.js > a flaky case" }]);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
});
