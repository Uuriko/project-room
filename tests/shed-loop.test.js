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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loop = join(root, "shed", "shed-loop.mjs");

function runLoop(t, { connDir, extraEnv = {} }) {
  const stateDir = mkdtempSync(join(tmpdir(), "shed-loop-test-"));
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
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30000);
  const done = new Promise(resolve => child.once("close", (code, signal) => {
    clearTimeout(timer); resolve({ code, signal, timedOut });
  }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await done;
    rmSync(stateDir, { recursive: true, force: true });
  });
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

  assert.deepEqual(await done, { code: 1, signal: null, timedOut: false }, "loop fails closed by exiting, not by being killed");
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

  assert.deepEqual(await done, { code: 1, signal: null, timedOut: false }, "loop fails closed by exiting, not by being killed");
});

// Reader contract: a heartbeat is absent or a complete snapshot, including
// while its replacement is being written. Existing startup/poll tests sample
// the file after a timer and cannot deterministically observe a partial write.
// This real-process fixture splits the filesystem write and reads the actual
// published path at that boundary. It adds no production injection seam and
// needs neither a connection nor an agent command. The direct-write baseline
// exposes "{" instead of the prior complete snapshot and fails this contract.
const observeHeartbeatWrites = String.raw`
  import fs from "node:fs";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  import { syncBuiltinESMExports } from "node:module";

  const [stateDir, fault, loop] = process.argv.slice(1);
  const heartbeat = join(stateDir, "heartbeat.json");
  const original = {
    open: fs.openSync, write: fs.writeFileSync, read: fs.readFileSync,
    close: fs.closeSync, rename: fs.renameSync,
  };
  const descriptors = new Map(), observations = [];
  const isHeartbeat = path => typeof path === "string"
    && (path === heartbeat || path.startsWith(heartbeat + "."));
  const published = () => {
    try { return original.read(heartbeat, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  fs.openSync = (path, flags, mode) => {
    if (fault === "collision" && isHeartbeat(path) && path !== heartbeat) {
      const other = original.open(path, "wx", 0o600);
      try { original.write(other, "another writer's temporary file"); } finally { original.close(other); }
      observations.push({ phase: "collision", path, published: published() });
    }
    const fd = original.open(path, flags, mode);
    if (isHeartbeat(path)) descriptors.set(fd, path);
    return fd;
  };
  fs.closeSync = fd => { descriptors.delete(fd); return original.close(fd); };
  fs.writeFileSync = (target, data, options) => {
    const path = typeof target === "number" ? descriptors.get(target) : target;
    if (!isHeartbeat(path)) return original.write(target, data, options);
    const bytes = Buffer.from(data);
    original.write(target, bytes.subarray(0, 1), options);
    observations.push({ phase: "partial", published: published() });
    if (fault === "write") throw Object.assign(new Error("injected write failure"), { code: "EIO" });
    // An fd advances after the prefix; a pathname reopens at offset zero.
    return original.write(target, typeof target === "number" ? bytes.subarray(1) : bytes, options);
  };
  fs.renameSync = (source, destination) => {
    if (destination !== heartbeat) return original.rename(source, destination);
    observations.push({ phase: "before-rename", published: published(), staged: original.read(source, "utf8") });
    if (fault === "rename") throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
    const result = original.rename(source, destination);
    observations.push({ phase: "after-rename", published: published() });
    return result;
  };
  syncBuiltinESMExports();
  process.on("exit", () => original.write(join(stateDir, "observations.json"), JSON.stringify(observations)));
  await import(pathToFileURL(loop).href);
`;

for (const { name, previous, fault = "none" } of [
  { name: "replacement", previous: true },
  { name: "first publication", previous: false },
  { name: "write failure", previous: true, fault: "write" },
  { name: "rename failure", previous: true, fault: "rename" },
  { name: "temporary-name collision", previous: true, fault: "collision" },
]) {
  test(`shed heartbeat publishes complete snapshots: ${name}`, { timeout: 20000 }, t => {
    const stateDir = mkdtempSync(join(tmpdir(), "shed-heartbeat-atomic-"));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const heartbeatPath = join(stateDir, "heartbeat.json");
    const oldBytes = previous ? JSON.stringify({ status: "ok", detail: { items: 3 } }, null, 1) + "\n" : null;
    if (previous) writeFileSync(heartbeatPath, oldBytes, { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", observeHeartbeatWrites, stateDir, fault, loop], {
      env: {
        ROOM_AGENT_CONFIG: join(stateDir, "missing-connection"),
        SHED_STATE_DIR: stateDir,
        SHED_AGENT_CMD: "",
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      },
      encoding: "utf8", timeout: 15000, killSignal: "SIGKILL",
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, `child was signalled: ${result.stderr}`);
    assert.equal(result.status, 1, `missing connection exits 1: ${result.stderr}`);
    const observations = JSON.parse(readFileSync(join(stateDir, "observations.json"), "utf8"));
    const before = observations.filter(entry => entry.phase !== "after-rename");
    assert.ok(before.length > 0, "observed a real heartbeat filesystem write");
    for (const entry of before) assert.equal(entry.published, oldBytes, `${entry.phase}: published heartbeat stays complete and unchanged`);
    const finalBytes = readFileSync(heartbeatPath, "utf8");
    const temporary = readdirSync(stateDir).filter(name => name.startsWith("heartbeat.json."));
    if (fault === "none") {
      const staged = observations.find(entry => entry.phase === "before-rename");
      assert.ok(staged, "observed the complete replacement before publication");
      assert.equal(staged.staged, finalBytes);
      assert.equal(observations.find(entry => entry.phase === "after-rename")?.published, finalBytes);
      const heartbeat = JSON.parse(finalBytes);
      assert.equal(heartbeat.status, "error");
      assert.equal(heartbeat.detail.code, "config_not_found");
      assert.equal(heartbeat.executeMode, false);
      assert.equal(finalBytes, JSON.stringify(heartbeat, null, 1) + "\n", "snapshot formatting is unchanged");
      assert.equal(statSync(heartbeatPath).mode & 0o777, 0o600);
    } else assert.equal(finalBytes, oldBytes, "failed replacement preserves the prior snapshot");
    if (fault === "collision") {
      assert.equal(temporary.length, 1, "a temporary file not owned by this writer survives");
      assert.equal(readFileSync(join(stateDir, temporary[0]), "utf8"), "another writer's temporary file");
    } else assert.deepEqual(temporary, [], "owned temporary files are cleaned up");
    const journal = readFileSync(join(stateDir, "attention.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(journal.some(entry => entry.event === "fatal"));
    assert.ok(!journal.some(entry => entry.event === "attention" || entry.event === "handoff"));
  });
}
