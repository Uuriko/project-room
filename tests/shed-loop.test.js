// tests/shed-loop.test.js — fail-closed startup contract for the shed loop.
//
// Authoring gate answers:
// 1. Protects: with a saved connection whose origin is unreachable, the loop
//    exits non-zero and writes heartbeat.json with status "error" — it never
//    sits in a silent degraded spin, and it never journals attention it did
//    not actually fetch.
// 2. Credible regression: the fatal branch in main() dropped or the heartbeat
//    write lost, leaving operators with no signal that the shed is dead.
// 3. Existing coverage: none — no test executes shed/shed-loop.mjs. The
//    contract gate only syntax-checks it.
// 4. Production seams: none. The test spawns the real loop as a child process
//    against a loopback origin that refuses connections (fast, no network).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loop = join(root, "shed", "shed-loop.mjs");

function runLoop(t, { connDir, extraEnv = {} }) {
  const stateDir = mkdtempSync(join(tmpdir(), "shed-loop-test-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [loop], {
    env: {
      ...process.env,
      ROOM_AGENT_CONFIG: connDir,
      SHED_STATE_DIR: stateDir,
      SHED_POLL_SECS: "15",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  const done = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, stateDir, done };
}

function waitForFile(path, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

test("shed loop fails closed on an unreachable origin: exit non-zero, error heartbeat, no journal", async t => {
  const dir = mkdtempSync(join(tmpdir(), "shed-loop-conn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const connDir = join(dir, "conn");
  mkdirSync(connDir, { recursive: true, mode: 0o700 });
  // Valid-shaped connection; nothing listens on 127.0.0.1:1, so the check
  // fails fast with "connection refused".
  writeFileSync(join(connDir, "connection.json"), JSON.stringify({
    version: 1,
    origin: "http://127.0.0.1:1",
    roomId: "test-room-1",
    memberId: "ai_testmember1",
    token: "rak_0123456789abcdef",
  }) + "\n", { mode: 0o600 });

  const { stateDir, done } = runLoop(t, { connDir });
  const heartbeatPath = join(stateDir, "heartbeat.json");

  await waitForFile(heartbeatPath);
  const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8"));
  assert.equal(heartbeat.status, "error", "heartbeat reports error, not ok/degraded");

  const { code } = await done;
  assert.notEqual(code, 0, "loop exits non-zero");
  // The journal may exist (it carries the fatal audit line), but it must not
  // contain any attention items from a connection that never validated.
  const journalPath = join(stateDir, "attention.jsonl");
  const lines = existsSync(journalPath)
    ? readFileSync(journalPath, "utf8").trim().split("\n").map(l => JSON.parse(l))
    : [];
  assert.ok(lines.some(e => e.event === "fatal"), "fatal event journaled as the audit trail");
  assert.ok(!lines.some(e => e.event === "attention"), "no attention items journaled without a validated connection");
});

test("shed loop fails closed with no connection configured", async t => {
  const { stateDir, done } = runLoop(t, { connDir: "/nonexistent-shed-conn" });
  const heartbeatPath = join(stateDir, "heartbeat.json");

  await waitForFile(heartbeatPath);
  const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8"));
  assert.equal(heartbeat.status, "error", "heartbeat reports error");
  assert.match(String(heartbeat.detail && heartbeat.detail.code), /config|not_found/, "names the config problem");

  const { code } = await done;
  assert.notEqual(code, 0, "loop exits non-zero");
});
