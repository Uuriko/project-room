// T3-L10g-C3: instance-lock release() used to unlink whatever file was at
// the lock path, including a successor's live lock. If a stale owner's
// lock was reclaimed and a successor created its own lock at the same
// path, the predecessor's graceful shutdown deleted the successor's lock
// and a third process could then boot onto the same database.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../server/instance-lock.mjs";

function lockDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "project-room-instance-lock-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SUCCESSOR = () => JSON.stringify({ pid: process.pid, startedAt: "2999-01-01T00:00:00.000Z" });

test("a stale owner's release does not delete a successor lock written over the path", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  const first = acquireInstanceLock(lockPath);
  // Simulate reclaim + create + write by a successor: its payload now
  // occupies the same path (the audit probe's in-place overwrite shape).
  writeFileSync(lockPath, SUCCESSOR(), { mode: 0o600 });
  first.release();
  assert.equal(existsSync(lockPath), true, "the successor's lock must survive the stale owner's release");
  assert.equal(readFileSync(lockPath, "utf8"), SUCCESSOR(), "the successor's payload must be intact");
});

test("a stale owner's release does not delete a successor lock recreated at the path", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  const first = acquireInstanceLock(lockPath);
  // The real reclaim shape: the stale file is unlinked and the successor
  // exclusive-creates a new file at the same path.
  unlinkSync(lockPath);
  writeFileSync(lockPath, SUCCESSOR(), { mode: 0o600, flag: "wx" });
  first.release();
  assert.equal(existsSync(lockPath), true, "the successor's recreated lock must survive");
  assert.equal(readFileSync(lockPath, "utf8"), SUCCESSOR());
  // And the surviving lock still does its job: a third boot is refused.
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.equal(error.code, "instance_lock_held");
    return true;
  });
});

test("release still removes the owner's own lock", t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  const lock = acquireInstanceLock(lockPath);
  assert.ok(existsSync(lockPath));
  lock.release();
  assert.equal(existsSync(lockPath), false, "an owner's release removes its own lock");
  lock.release(); // idempotent: never throws
});
