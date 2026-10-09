// Fail-first regression: browser-check setup must register its t.after cleanup
// BEFORE chromium.launch, so a launch failure still tears down the fixture
// server and temp dir instead of leaking them and hanging the runner.
//
// Repro (pre-fix): run any single test of scripts/action-recovery-browser-check.mjs
// with ROOM_TEST_CHROMIUM_PATH=/nonexistent-bogus. chromium.launch throws, the
// t.after was never registered, the fixture dir (/tmp/project-room-acceptance-*)
// leaks, and the still-listening server keeps the event loop alive until killed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureLeftovers(dir) {
  return readdirSync(dir).filter((e) => e.startsWith("project-room-acceptance-"));
}

// Runs one browser-check test with a guaranteed-failing chromium launch and
// asserts the child exits promptly (no hang) with no fixture dir left behind.
// NOTE: the child is spawned as plain `node` (not `node --test`): the test
// runner refuses to run files recursively inside a test file
// ("run() is being called recursively ... skipping running files").
function runLaunchFailure(script, namePattern) {
  const childTmp = mkdtempSync(join(tmpdir(), "browser-cleanup-test-"));
  const before = fixtureLeftovers(childTmp);
  const r = spawnSync(process.execPath, [`--test-name-pattern=${namePattern}`, join(ROOT, script)], {
    cwd: ROOT,
    timeout: 45000,
    env: {
      ...process.env,
      TMPDIR: childTmp, // isolate fixture dirs: os.tmpdir() honors TMPDIR
      ROOM_TEST_CHROMIUM_PATH: "/nonexistent-bogus-chromium",
      PLAYWRIGHT_BROWSERS_PATH: "/nonexistent-bogus-browsers",
      NO_COLOR: "1",
    },
  });
  const leftovers = fixtureLeftovers(childTmp).filter((e) => !before.includes(e));
  return { timedOut: r.error?.code === "ETIMEDOUT", status: r.status, leftovers, stderr: (r.stderr || Buffer.alloc(0)).toString() };
}

for (const [script, pattern] of [
  ["scripts/action-recovery-browser-check.mjs", "work action committed-empty: close"],
  ["scripts/gmail-setup-browser-check.mjs", "ends in the room at 390px"],
]) {
  test(`${script}: chromium launch failure still cleans up (no hang, no fixture leak)`, { timeout: 120000 }, () => {
    const { timedOut, status, leftovers, stderr } = runLaunchFailure(script, pattern);
    assert.equal(timedOut, false, `${script}: child hung — cleanup was not registered before chromium.launch.\nstderr:\n${stderr.slice(-2000)}`);
    assert.notEqual(status, 0, `${script}: expected the test to fail on the bogus chromium path`);
    assert.deepEqual(leftovers, [], `${script}: fixture temp dir leaked on launch failure`);
  });
}
