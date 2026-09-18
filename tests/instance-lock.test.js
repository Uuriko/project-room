import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
