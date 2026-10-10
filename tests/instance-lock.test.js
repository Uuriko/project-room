import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, INSTANCE_LOCK_ERRORS } from "../server/instance-lock.mjs";

function lockDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "project-room-instance-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("acquire creates the lock and release removes it", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  const lock = acquireInstanceLock(lockPath);
  assert.ok(existsSync(lockPath), "lock file exists while held");
  const payload = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(payload.pid, process.pid);
  assert.equal(typeof payload.startedAt, "string");
  lock.release();
  assert.equal(existsSync(lockPath), false, "release removes the lock file");
  lock.release(); // idempotent: never throws
});

test("second acquire on a live lock is refused with a coded error", t => {
  assert.ok(INSTANCE_LOCK_ERRORS.includes("instance_lock_held"));
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  const first = acquireInstanceLock(lockPath);
  t.after(() => first.release());
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, "instance_lock_held");
    assert.match(error.message, /another project-room instance/);
    return true;
  });
});

test("a stale lock (dead pid) is reclaimed", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  // 2^31-2 is not a plausible live pid on this host.
  writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, startedAt: "2020-01-01T00:00:00.000Z" }), { mode: 0o600 });
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(lock.pid, process.pid, "the new owner holds the reclaimed lock");
});

test("a malformed lock file is reclaimed, not fatal", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  writeFileSync(lockPath, "not-json{{{", { mode: 0o600 });
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(lock.pid, process.pid);
});

test("acquiring in a missing directory surfaces a coded io error", t => {
  const lockPath = join(tmpdir(), "project-room-no-such-dir-9f31", ".project-room.lock");
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.equal(error.code, "instance_lock_io");
    return true;
  });
});

// Schedule real boot processes at filesystem boundaries. The hooks only pause
// after the real operation; they do not implement or substitute lock behavior.
async function bootContender(t, lockPath, pauseAfter = null) {
  const barrier = `${lockPath}.continue-${Math.random()}`;
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const lockPath = ${JSON.stringify(lockPath)};
    const barrier = ${JSON.stringify(barrier)};
    const pauseAfter = ${JSON.stringify(pauseAfter)};
    let paused = false;
    const pause = () => {
      if (paused) return;
      paused = true;
      process.send({ kind: "paused" });
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(barrier)) {
        if (Date.now() > deadline) throw new Error("boot test barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    };
    for (const name of ["openSync", "readFileSync"]) {
      const original = fs[name];
      fs[name] = (...args) => {
        const result = original(...args);
        if (args[0] === lockPath && name === pauseAfter) pause();
        return result;
      };
    }
    syncBuiltinESMExports();
    const { acquireInstanceLock } = await import(${JSON.stringify(new URL("../server/instance-lock.mjs", import.meta.url).href)});
    let lock;
    try {
      lock = acquireInstanceLock(lockPath);
      process.send({ kind: "acquired", pid: process.pid });
    } catch (error) { process.send({ kind: "refused", code: error.code }); }
    process.on("message", () => { lock?.release(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = [];
  const listeners = new Set();
  child.on("message", message => {
    messages.push(message);
    for (const listener of listeners) listener();
  });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGKILL");
      await closed;
    }
    try { unlinkSync(barrier); } catch { /* not resumed */ }
  });
  return {
    child,
    resume: () => writeFileSync(barrier, "continue"),
    next: kinds => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`boot result timed out: ${diagnostics}`)); }, 12000);
      const check = () => {
        const index = messages.findIndex(message => kinds.includes(message.kind));
        if (index < 0) return;
        clearTimeout(timer); listeners.delete(check); resolve(messages.splice(index, 1)[0]);
      };
      listeners.add(check); check();
    }),
  };
}

test("concurrent boots never reclaim a live creator's unfinished lock", async t => {
  const lockPath = join(lockDir(t), ".project-room.lock");
  const first = await bootContender(t, lockPath, "openSync");
  await first.next(["paused", "acquired"]);
  const second = await bootContender(t, lockPath);
  const outcome = await second.next(["acquired", "refused"]);
  first.resume();
  assert.equal(outcome.kind, "refused", "a second boot must not acquire while the first is alive");
});

test("stale reclaim never removes another contender's newly acquired lock", async t => {
  const lockPath = join(lockDir(t), ".project-room.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 2147483646 }));
  const first = await bootContender(t, lockPath, "readFileSync");
  await first.next(["paused", "acquired"]);
  const second = await bootContender(t, lockPath);
  const outcome = await second.next(["acquired", "refused"]);
  first.resume();
  const firstOutcome = await first.next(["acquired", "refused"]);
  assert.notEqual(`${outcome.kind}/${firstOutcome.kind}`, "acquired/acquired", "only one boot may reclaim a stale lock");
});


test("release leaves a replacement lock intact", t => {
  const lockPath = join(lockDir(t), ".project-room.lock");
  const first = acquireInstanceLock(lockPath);
  unlinkSync(lockPath);
  const second = acquireInstanceLock(lockPath);
  t.after(() => second.release());
  first.release();
  assert.ok(existsSync(lockPath), "the replacement owner's lock survives the earlier owner's release");
  assert.throws(() => acquireInstanceLock(lockPath), { code: "instance_lock_held" });
});

test("a killed boot leaves a lock that the next real process reclaims", async t => {
  const lockPath = join(lockDir(t), ".project-room.lock");
  const first = await bootContender(t, lockPath);
  assert.equal((await first.next(["acquired", "refused"])).kind, "acquired");
  const exited = new Promise(resolve => first.child.once("exit", resolve));
  first.child.kill("SIGKILL");
  await exited;
  const next = await bootContender(t, lockPath);
  assert.equal((await next.next(["acquired", "refused"])).kind, "acquired");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, next.child.pid);
});
