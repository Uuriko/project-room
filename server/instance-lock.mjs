// Single-instance boot lock for server.mjs.
//
// The room store is SQLite (serializes writes), but the growth snapshot is a
// plain JSON file: two server.mjs processes on one database race it
// (last-writer-wins / torn write on concurrent shutdown). The lock is an
// exclusive-create file next to the database holding the owner's PID and
// process start ticks; a stale lock (dead PID, a live PID whose start ticks
// prove it is a different process that reused the PID, or malformed content)
// is reclaimed exactly once. The lock
// holder keeps the fd open for the process lifetime and releases (close +
// unlink) on graceful shutdown; a crash leaves a stale file that the next
// boot reclaims via the PID-liveness check.
//
// This replaces the deleted src/multi-instance-election.mjs: that module was
// a lease election for a multi-instance deploy that was never wired to any
// production path. The supported topology is one server per database.
import { openSync, readFileSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
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

// The holder's process start time (Linux /proc/<pid>/stat field 22, clock
// ticks since boot). A bare pid is not an identity: after a crash the OS can
// reassign the dead server's pid to an unrelated live process — most
// reliably in containers, where the server often runs as a low pid and the
// next boot's init/supervisor holds a low pid again — and a liveness-only
// check then refuses every future boot (#3584). Start ticks are assigned
// once per process lifetime, so a live pid whose start ticks differ from
// the recorded ones is a different process that happens to share the pid.
// Returns null where /proc is unavailable (non-Linux, restricted procfs):
// callers then fall back to the liveness-only verdict rather than guessing.
export function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // afterComm[0] is field 3 (state); starttime is field 22 → index 19.
    const ticks = Number(afterComm[19]);
    return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
  } catch { return null; }
}

// True only when the recorded holder is plausibly still the process on the
// database: pid alive AND, where both start-tick readings exist, identical.
// A pid alive with different start ticks is a reused pid — the recorded
// holder is dead and its lock is stale.
const lockHolderAlive = existing => {
  if (!pidAlive(existing.pid)) return false;
  if (Number.isSafeInteger(existing.startTicks)) {
    const liveTicks = processStartTicks(existing.pid);
    if (liveTicks !== null) return liveTicks === existing.startTicks;
  }
  return true;
};

const readLock = lockPath => {
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf8"));
    if (data && Number.isSafeInteger(data.pid) && data.pid > 0) return data;
  } catch { /* malformed: treated as stale below */ }
  return null;
};

// An empty lock file is ambiguous: it is either a crash leftover or a live
// peer in the window between its exclusive create and its payload write
// (adjacent calls in acquireInstanceLock, so the write follows immediately).
// Only an empty file older than this grace window may be treated as a
// leftover; a fresh one must be assumed to belong to a peer still starting.
const EMPTY_LOCK_GRACE_MS = 5_000;

const isFreshEmptyLock = lockPath => {
  try {
    const stat = statSync(lockPath);
    return stat.size === 0 && Date.now() - stat.mtimeMs < EMPTY_LOCK_GRACE_MS;
  } catch { return false; }
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
    if (existing && lockHolderAlive(existing)) {
      throw lockError("instance_lock_held",
        `another project-room instance holds this database (pid ${existing.pid}, started ${existing.startedAt ?? "unknown"}); refusing to boot`);
    }
    // An empty file has no payload to judge yet, but it may be a peer that
    // created the lock a moment ago and has not written its payload.
    // Reclaiming it here would put two processes on one database, so a
    // fresh empty lock is refused as held; only an older empty file (a
    // crash between create and write) falls through to the reclaim below.
    if (!existing && isFreshEmptyLock(lockPath)) {
      throw lockError("instance_lock_held",
        `another project-room instance is starting on this database (lock ${lockPath} was just created and has no payload yet); refusing to boot`);
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
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), startTicks: processStartTicks(process.pid) }));
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
