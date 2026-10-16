import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, INSTANCE_LOCK_ERRORS, processStartTicks } from "../server/instance-lock.mjs";

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

test("the lock payload records the holder's process start ticks", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  const payload = JSON.parse(readFileSync(lockPath, "utf8"));
  const own = processStartTicks(process.pid);
  if (own !== null) assert.equal(payload.startTicks, own, "payload binds the holder's start ticks");
  else assert.equal(payload.startTicks, null, "no /proc: start ticks recorded as null, liveness-only behavior");
});

test("a lock whose pid was reused by a different process is reclaimed (#3584)", t => {
  const own = processStartTicks(process.pid);
  if (own === null) return; // /proc unavailable: the identity check is inert.
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  // The crash leftover as the next boot sees it after the OS reassigned the
  // dead server's pid: the pid is alive (here, this very test process) but
  // its start ticks are not the recorded holder's. Liveness alone would
  // refuse every future boot; the identity check must reclaim instead.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z", startTicks: own + 1_000_000 }), { mode: 0o600 });
  const lock = acquireInstanceLock(lockPath);
  t.after(() => lock.release());
  assert.equal(lock.pid, process.pid, "the reused-pid lock was reclaimed");
});

test("a lock naming a live holder with matching start ticks is still refused", t => {
  const own = processStartTicks(process.pid);
  if (own === null) return;
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), startTicks: own }), { mode: 0o600 });
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.equal(error.code, "instance_lock_held");
    return true;
  });
  assert.ok(existsSync(lockPath), "the live holder's lock must not be unlinked");
});

test("a legacy lock without start ticks keeps liveness-only behavior", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  // Pre-#3584 payloads carry no startTicks; a live pid in one is still a
  // holder (no basis to call it reused), so the boot is refused.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.equal(error.code, "instance_lock_held");
    return true;
  });
});

test("acquiring in a missing directory surfaces a coded io error", t => {
  const lockPath = join(tmpdir(), "project-room-no-such-dir-9f31", ".project-room.lock");
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.equal(error.code, "instance_lock_io");
    return true;
  });
});
