// Gate canary for scripts/quarantine-check.mjs (#3681 tranche T6, alternate).
//
// Runs the real gate as a subprocess against fixture quarantine files under
// a spaced path. An expired entry must fail naming the entry; a current
// entry passes; a missing file is a usage error, never a silent pass.
// Dates are computed from today so the fixtures cannot rot.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../scripts/quarantine-check.mjs", import.meta.url));

const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

function fixture(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), "gate canary quarantine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "quarantine fixture.json");
  writeFileSync(file, JSON.stringify({ quarantined: entries }));
  return file;
}

function runGate(file) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [GATE, file], { encoding: "utf8", timeout: 60000, env });
}

test("canary: an overdue quarantine entry fails and the output names it", (t) => {
  const file = fixture(t, [{
    test: "tests/spaced flake.test.js > canary case",
    reason: "fixture failure signature",
    owner: "gate-canary",
    quarantined_at: isoDay(-20),
    repair_by: isoDay(-13),
  }]);
  const run = runGate(file);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /spaced flake\.test\.js/);
  assert.match(run.stderr, /OVERDUE/);
});

test("canary: a current quarantine entry passes", (t) => {
  const file = fixture(t, [{
    test: "tests/spaced flake.test.js > canary case",
    reason: "fixture failure signature",
    owner: "gate-canary",
    quarantined_at: isoDay(0),
    repair_by: isoDay(7),
  }]);
  const run = runGate(file);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /OK — 1 quarantined test\(s\)/);
});

test("canary: a missing quarantine file is an error naming the path, not a pass", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gate canary quarantine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = runGate(join(dir, "no such file.json"));
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /cannot read\/parse/);
  assert.match(run.stderr, /no such file\.json/);
});
