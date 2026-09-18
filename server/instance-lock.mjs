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
import { openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
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

const readLock = lockPath => {
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf8"));
    if (data && Number.isSafeInteger(data.pid) && data.pid > 0) return data;
  } catch { /* malformed: treated as stale below */ }
  return null;
};

export function acquireInstanceLock(lockPath) {
  const create = () => {
    try { return openSync(lockPath, "wx", 0o600); }
    catch (error) { return { createError: error }; }
  };
  let fd = create();
  if (fd.createError !== undefined) {
    const error = fd.createError;
    if (error?.code !== "EEXIST") {
      throw lockError("instance_lock_io", `instance lock: cannot create ${lockPath}: ${error?.message ?? error}`);
    }
    const existing = readLock(lockPath);
    if (existing && pidAlive(existing.pid)) {
      throw lockError("instance_lock_held",
        `another project-room instance holds this database (pid ${existing.pid}, started ${existing.startedAt ?? "unknown"}); refusing to boot`);
    }
    // Stale or malformed lock: reclaim exactly once. If a racing process
    // grabbed it between our unlink and re-create, the re-create fails and
    // we report the contention instead of writing over their lock.
    try { unlinkSync(lockPath); }
    catch (unlinkError) { throw lockError("instance_lock_io", `instance lock: cannot reclaim stale lock ${lockPath}: ${unlinkError?.message ?? unlinkError}`); }
    fd = create();
    if (fd.createError !== undefined) {
      throw lockError("instance_lock_io", `instance lock: lock contention on ${lockPath}: ${fd.createError?.message ?? fd.createError}`);
    }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    try { closeSync(fd); } catch { /* never mask the write error */ }
    try { unlinkSync(lockPath); } catch { /* never mask the write error */ }
    throw lockError("instance_lock_io", `instance lock: cannot write ${lockPath}: ${error?.message ?? error}`);
  }
  let released = false;
  return {
    path: lockPath,
    pid: process.pid,
    release() {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch { /* fd already closed; shutdown must not throw */ }
      try { unlinkSync(lockPath); } catch { /* a racing boot may have reclaimed; shutdown must not throw */ }
    }
  };
}
