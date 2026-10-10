// Single-instance boot lock for server.mjs.
//
// The room store is SQLite (serializes writes), but the growth snapshot is a
// plain JSON file: two server.mjs processes on one database race it
// (last-writer-wins / torn write on concurrent shutdown). The lock is an
// exclusive-create file next to the database holding the owner's PID; a stale
// lock (dead PID or malformed content) is reclaimed exactly once. The lock
// holder keeps the fd open for the process lifetime and releases (close +
// unlink) on graceful shutdown; a crash leaves a stale file that the next
// boot reclaims via the PID-liveness check.
//
// This replaces the deleted src/multi-instance-election.mjs: that module was
// a lease election for a multi-instance deploy that was never wired to any
// production path. The supported topology is one server per database.
import { openSync, readFileSync, unlinkSync, writeSync, closeSync, linkSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import process from "node:process";

export const INSTANCE_LOCK_ERRORS = Object.freeze(["instance_lock_held", "instance_lock_io"]);

const lockError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

// process.kill(pid, 0) is the portable "does this pid exist" probe: it throws
// ESRCH for a dead pid and EPERM for a live pid owned by another user.
const pidAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

// Paths this process currently holds. A lock file naming our own pid is
// stale when the path is NOT in this set (a previous boot of this container
// wrote it; a restart reuses the pid), but a live double-acquire when it IS
// (we hold it right now) - the first case reclaims, the second refuses.
const heldPaths = new Set();

const readLock = lockPath => {
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf8"));
    if (data && Number.isSafeInteger(data.pid) && data.pid > 0) return data;
  } catch { /* malformed: treated as stale below */ }
  return null;
};

// REL-23: the lock file must never be visible half-written. The old code
// opened it with "wx" and wrote the PID afterwards; a racing boot that read
// the empty file in between treated it as malformed, unlinked it and took a
// second lock (measured: 2+ holders in 10/20 trials with 8 concurrent boots,
// 25/40 with 2 boots on a stale lock). Now the full payload goes to a private
// temp file first and link() publishes it atomically. Stale reclaim runs only
// inside a mkdir() mutex and re-reads the lock there, so no process can
// unlink a lock that another process has just published.
const RECLAIM_MUTEX_STALE_MS = 10_000;

const publish = lockPath => {
  const temp = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* keep original error */ } }
    try { unlinkSync(temp); } catch { /* keep original error */ }
    return { publishError: error, stage: "write" };
  }
  try { linkSync(temp, lockPath); }
  catch (error) {
    try { closeSync(fd); } catch { /* keep original error */ }
    try { unlinkSync(temp); } catch { /* keep original error */ }
    return { publishError: error, stage: "link" };
  }
  try { unlinkSync(temp); } catch { /* the lock path still names the inode */ }
  return { fd };
};

const withReclaimMutex = (lockPath, fn) => {
  const mutex = `${lockPath}.reclaim`;
  const take = () => { try { mkdirSync(mutex, { mode: 0o700 }); return true; } catch (error) { if (error?.code === "EEXIST") return false; throw error; } };
  let held;
  try { held = take(); }
  catch (error) { throw lockError("instance_lock_io", `instance lock: cannot create reclaim marker ${mutex}: ${error?.message ?? error}`); }
  if (!held) {
    // A process that crashed mid-reclaim leaves the marker; a reclaim takes
    // milliseconds, so an old marker is dead and is cleared once.
    let age = 0;
    try { age = Date.now() - statSync(mutex).mtimeMs; } catch { age = Infinity; }
    if (age > RECLAIM_MUTEX_STALE_MS) { try { rmdirSync(mutex); } catch { /* raced; take() decides */ } try { held = take(); } catch { held = false; } }
    if (!held) throw lockError("instance_lock_io", `instance lock: lock contention on ${lockPath}: another boot is reclaiming it`);
  }
  try { return fn(); }
  finally { try { rmdirSync(mutex); } catch { /* never mask the result */ } }
};

const heldError = existing => lockError("instance_lock_held",
  `another project-room instance holds this database (pid ${existing.pid}, started ${existing.startedAt ?? "unknown"}); refusing to boot`);

export function acquireInstanceLock(lockPath) {
  let result = publish(lockPath);
  if (result.publishError !== undefined) {
    const error = result.publishError;
    if (result.stage !== "link" || error?.code !== "EEXIST") {
      throw lockError("instance_lock_io", `instance lock: cannot create ${lockPath}: ${error?.message ?? error}`);
    }
    const existing = readLock(lockPath);
    // REL-23 (A14): a lock naming OUR OWN pid is stale by definition - two
    // live processes never share a pid. A container restart reuses pid 1,
    // so the previous boot's lock would otherwise refuse every future boot.
    if (existing && (heldPaths.has(lockPath) || (existing.pid !== process.pid && pidAlive(existing.pid)))) throw heldError(existing);
    result = withReclaimMutex(lockPath, () => {
      // Re-read under the mutex: a published lock may have replaced the
      // stale one since the first read.
      const current = readLock(lockPath);
      if (current && (heldPaths.has(lockPath) || (current.pid !== process.pid && pidAlive(current.pid)))) throw heldError(current);
      try { unlinkSync(lockPath); }
      catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw lockError("instance_lock_io", `instance lock: cannot reclaim stale lock ${lockPath}: ${unlinkError?.message ?? unlinkError}`);
      }
      const retry = publish(lockPath);
      if (retry.publishError !== undefined) {
        throw lockError("instance_lock_io", `instance lock: lock contention on ${lockPath}: ${retry.publishError?.message ?? retry.publishError}`);
      }
      return retry;
    });
  }
  const fd = result.fd;
  heldPaths.add(lockPath);
  let released = false;
  return {
    path: lockPath,
    pid: process.pid,
    release() {
      if (released) return;
      released = true;
      heldPaths.delete(lockPath);
      try { closeSync(fd); } catch { /* fd already closed; shutdown must not throw */ }
      // Unlink only our own lock: after a crash-reclaim race the path may
      // name another boot's lock.
      const current = readLock(lockPath);
      if (current && current.pid !== process.pid) return;
      try { unlinkSync(lockPath); } catch { /* shutdown must not throw */ }
    }
  };
}
