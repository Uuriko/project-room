// fixwave C2 — fail-first tests for WAVE-500 S-instance-lock
// (server/instance-lock.mjs): PID reuse must not falsely report "another
// instance holds this database". The stale-lock reclaim cross-checks the
// lock's recorded start time against the live process's actual start time
// (Linux /proc); a live PID with a mismatched start time is a recycled PID
// and the lock is reclaimed. Fail-closed: anything unverifiable keeps the
// old refuse-to-boot behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, processStartMatches } from "../server/instance-lock.mjs";

const lockDir = t => {
  const dir = mkdtempSync(join(tmpdir(), "project-room-instance-lock-pidreuse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// This process's true start time, the value a legitimately-held lock records.
const ownStartIso = () => new Date(Date.now() - process.uptime() * 1000).toISOString();
const procAvailable = existsSync("/proc/self/stat");

test("processStartMatches: own pid with its true start time matches", { skip: !procAvailable }, () => {
  assert.equal(processStartMatches(process.pid, ownStartIso()), true);
});

test("processStartMatches: same pid with a wrong start time is a recycled PID", { skip: !procAvailable }, () => {
  assert.equal(
    processStartMatches(process.pid, new Date(Date.now() - 3600_000).toISOString()),
    false,
    "a live pid whose start time disagrees with the lock must not block boot",
  );
});

test("processStartMatches fails closed on legacy or unverifiable input", () => {
  assert.equal(processStartMatches(process.pid, null), true, "legacy lock without startedAt keeps old behavior");
  assert.equal(processStartMatches(process.pid, undefined), true);
  assert.equal(processStartMatches(process.pid, "not-a-date"), true, "garbage startedAt keeps old behavior");
  assert.equal(processStartMatches(2147483646, new Date().toISOString()), true,
    "unreadable /proc entry keeps old behavior");
});

test("a lock naming a live pid with a mismatched start time is reclaimed, not refused", { skip: !procAvailable }, t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  // Our own pid is certainly live; the bogus startedAt simulates PID reuse
  // after the lock owner's death.
  writeFileSync(lockPath,
    JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 3600_000).toISOString() }),
    { mode: 0o600 });
  const lock = acquireInstanceLock(lockPath); // pre-fix: throws instance_lock_held
  t.after(() => lock.release());
  assert.equal(lock.pid, process.pid, "the new boot holds the reclaimed lock");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid,
    "the reclaimed lock names the new owner");
});

test("a lock naming a live pid with its true start time is still refused", { skip: !procAvailable }, t => {
  const dir = lockDir(t);
  const lockPath = join(dir, ".project-room.lock");
  writeFileSync(lockPath,
    JSON.stringify({ pid: process.pid, startedAt: ownStartIso() }),
    { mode: 0o600 });
  assert.throws(() => acquireInstanceLock(lockPath), error => {
    assert.equal(error.code, "instance_lock_held");
    assert.match(error.message, /another project-room instance/);
    return true;
  }, "a genuinely-held lock still refuses the second boot");
});
