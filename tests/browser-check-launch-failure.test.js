// Regression: a chromium launch failure (missing binary, bad
// ROOM_TEST_CHROMIUM_PATH) must fail the check fast, not hang the runner.
// The disposable HTTP server keeps the event loop alive, so t.after cleanup
// has to be registered BEFORE chromium.launch(); otherwise the process never
// exits and CI sits on the job until its own timeout.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = [
  "scripts/action-dialog-focus-scroll-browser-check.mjs",
  "scripts/chat-suggestions-browser-check.mjs",
  // gmail-setup-browser-check.mjs is covered by tests/browser-check-cleanup.test.js
  // (sibling worker's fail-first test, which also asserts no fixture-dir leak).
];
// A run that hangs is killed here; a correctly torn-down run exits in seconds.
const KILL_AFTER_MS = 45000;

for (const script of SCRIPTS) {
  test(`${script}: chromium launch failure exits instead of hanging`, { timeout: 90000 }, async () => {
    const tmp = join(ROOT, ".tmp", "launch-failure-probe");
    mkdirSync(tmp, { recursive: true });
    const child = spawn(process.execPath, [join(ROOT, script)], {
      env: {
        ...process.env,
        ROOM_TEST_CHROMIUM_PATH: "/nonexistent-chromium-guild06",
        TMPDIR: tmp,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", d => { output += d; });
    child.stderr.on("data", d => { output += d; });
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, KILL_AFTER_MS);
      child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.notEqual(outcome, "timeout",
      `${script} hung after a chromium launch failure (killed after ${KILL_AFTER_MS}ms): ` +
      "t.after cleanup was not registered before chromium.launch(), so the listening server kept the process alive");
    assert.equal(outcome.signal, null, `child died from signal ${outcome.signal}`);
    assert.notEqual(outcome.code, 0, "expected the check to fail (chromium is missing)");
    assert.match(output, /not ok|Failed to launch chromium|✖|failing tests/, "expected failing-test output, not a silent exit");
  });
}
