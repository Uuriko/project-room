// Single-instance boot lock for server.mjs (Workers do not use this module).
// Publish a completely written inode with link(), so competing boots never
// observe an empty lock. Serialize stale removal with a short-lived directory
// mutex and re-read the lock inside it. A crash during reclaim leaves the mutex
// behind: fail closed and require an operator to remove it after stopping all
// boots, rather than risk removing another process's reclaim mutex.
import { openSync, readFileSync, unlinkSync, writeFileSync, closeSync, linkSync,
  mkdirSync, rmdirSync, fstatSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import process from "node:process";

export const INSTANCE_LOCK_ERRORS = Object.freeze(["instance_lock_held", "instance_lock_io"]);

const lockError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const pidAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

const readLock = lockPath => {
  let text;
  try { text = readFileSync(lockPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { exists: false, owner: null };
    throw lockError("instance_lock_io", `instance lock: cannot read ${lockPath}: ${error?.message ?? error}`);
  }
  try {
    const data = JSON.parse(text);
    if (data && Number.isSafeInteger(data.pid) && data.pid > 0) return { exists: true, owner: data };
  } catch { /* malformed content can be reclaimed under the mutex */ }
  return { exists: true, owner: null };
};

const assertNotHeld = existing => {
  if (existing.owner && pidAlive(existing.owner.pid)) {
    throw lockError("instance_lock_held",
      `another project-room instance holds this database (pid ${existing.owner.pid}, started ${existing.owner.startedAt ?? "unknown"}); refusing to boot`);
  }
};

export function acquireInstanceLock(lockPath) {
  const create = () => {
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      linkSync(temporary, lockPath);
      return { fd, inode: fstatSync(fd) };
    } catch (error) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* preserve original error */ }
      return { createError: error };
    } finally {
      try { unlinkSync(temporary); } catch { /* temporary path may not exist */ }
    }
  };
  let result = create();
  if (result.createError !== undefined) {
    const error = result.createError;
    if (error?.code !== "EEXIST") {
      throw lockError("instance_lock_io", `instance lock: cannot create ${lockPath}: ${error?.message ?? error}`);
    }
    assertNotHeld(readLock(lockPath));
    const reclaimPath = `${lockPath}.reclaim`;
    try { mkdirSync(reclaimPath, { mode: 0o700 }); }
    catch (error) {
      throw lockError("instance_lock_io", `instance lock: cannot enter stale-reclaim mutex ${reclaimPath}: ${error?.message ?? error}; if a boot crashed during reclaim, stop all boots before removing this directory`);
    }
    try {
      const existing = readLock(lockPath);
      assertNotHeld(existing);
      // Never unlink a path that was absent when read: a fresh contender can
      // publish there without taking the stale-reclaim mutex.
      if (existing.exists) unlinkSync(lockPath);
      result = create();
      if (result.createError !== undefined) {
        throw lockError("instance_lock_io", `instance lock: lock contention on ${lockPath}: ${result.createError?.message ?? result.createError}`);
      }
    } catch (error) {
      if (INSTANCE_LOCK_ERRORS.includes(error?.code)) throw error;
      throw lockError("instance_lock_io", `instance lock: cannot reclaim ${lockPath}: ${error?.message ?? error}`);
    } finally {
      try { rmdirSync(reclaimPath); } catch { /* shutdown/reclaim must preserve the original error */ }
    }
  }
  const { fd, inode } = result;
  let released = false;
  return {
    path: lockPath,
    pid: process.pid,
    release() {
      if (released) return;
      released = true;
      try {
        const current = statSync(lockPath);
        if (current.dev === inode.dev && current.ino === inode.ino) unlinkSync(lockPath);
      } catch { /* absent or replaced lock; shutdown must not throw */ }
      try { closeSync(fd); } catch { /* shutdown must not throw */ }
    }
  };
}
