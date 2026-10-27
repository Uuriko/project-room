import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, pidAlive, procState, INSTANCE_LOCK_ERRORS } from "../server/instance-lock.mjs";
import { spawnSync } from "node:child_process";

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

test("a just-created empty lock file is treated as held, not stolen", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  // The state a second boot observes when a peer has created the lock with
  // openSync("wx") but has not written its payload yet. Reclaiming it would
  // put both processes on one database.
  writeFileSync(lockPath, "", { mode: 0o600 });
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.equal(error.code, "instance_lock_held");
    assert.match(error.message, /refusing to boot/);
    return true;
  });
  assert.ok(existsSync(lockPath), "the peer's lock file must not be unlinked");
  assert.equal(readFileSync(lockPath, "utf8"), "", "the peer's lock file must not be overwritten");
});

test("an old empty lock file is a crash leftover and is reclaimed", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  // A peer that crashed between create and write leaves an empty file that
  // never gains a payload; once it is older than the startup grace window
  // it must not block boots forever.
  writeFileSync(lockPath, "", { mode: 0o600 });
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lockPath, longAgo, longAgo);
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(lock.pid, process.pid);
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

test("pidAlive answers for a live pid and a bogus pid", t => {
  assert.equal(pidAlive(process.pid), true, "the running test process is alive");
  assert.equal(pidAlive(2147483646), false, "an implausible pid is not alive");
});

// Regression: pidAlive used process.kill(pid, 0) only. A zombie (an exited
// process never reaped by its parent) answers signal 0, so after a SIGKILLed
// server left an unreaped zombie behind, every later boot on the same
// database directory was refused forever instead of reclaiming the lock.
// A zombie is created deterministically with a tiny python3 helper: fork a
// child that exits immediately, then do not wait() on it for a few seconds.
test("a zombie pid reads as dead and its lock is reclaimed", t => {
  const probe = spawnSync("python3", [
    "-c",
    "import os,sys,time\np=os.fork()\nif p==0: os._exit(0)\nprint(p,flush=True)\ntime.sleep(6)",
  ], { encoding: "utf8", timeout: 10_000 });
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    t.skip(`no python3 fork available on this host (status ${probe.status})`);
    return;
  }
  const zombie = Number(probe.stdout.trim());
  if (!Number.isSafeInteger(zombie) || zombie <= 0) {
    t.skip("python3 did not report a usable pid");
    return;
  }
  const state = procState(zombie);
  assert.equal(state, "Z", "the unreaped child is a zombie in /proc");
  assert.equal(pidAlive(zombie), false, "a zombie is not an alive lock holder");
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: zombie, startedAt: "2020-01-01T00:00:00.000Z" }), { mode: 0o600 });
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(lock.pid, process.pid, "the zombie-held lock is reclaimed");
});
