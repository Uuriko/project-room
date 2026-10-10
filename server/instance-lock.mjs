// Single-instance boot lock for server.mjs.
//
// The room store is SQLite (serializes writes), but the growth snapshot is a
// plain JSON file: two server.mjs processes on one database race it
// (last-writer-wins / torn write on concurrent shutdown). The lock is an
// exclusive-create file next to the database holding the owner's PID; a stale
// lock (dead PID, malformed content, or a PID recycled by an unrelated live
// process — detected via a process-start-time cross-check) is reclaimed
// exactly once. The lock
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
// It cannot tell a live pid from a RECYCLED one, so a stale lock is also
// cross-checked against the process start time (processStartMatches below):
// a live pid whose start time disagrees with the lock's is an unrelated
// process that inherited the number, and the lock is stale.
const pidAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

// /proc/<pid>/stat field 22 (starttime) sits at this index after stripping
// "pid (comm)": fields are 1-based, so field 22 -> tokens[19].
const PROC_STAT_STARTTIME_INDEX = 19;
// A recycled pid's process almost never started within this window of the
// recorded lock time; anything closer is indistinguishable, so we refuse.
const PID_START_TOLERANCE_MS = 60_000;

// Measure the kernel's USER_HZ from our own process: starttime ticks divided
// by seconds since boot must equal the tick rate. Returns null when it
// cannot be established (non-Linux, odd /proc, insane value) — callers fail
// closed to "matches" in that case.
const clockTickHz = () => {
  try {
    const self = readFileSync("/proc/self/stat", "utf8");
    const ticks = Number(self.slice(self.lastIndexOf(")") + 1).trim().split(/\s+/)[PROC_STAT_STARTTIME_INDEX]);
    const btime = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    const bootSeconds = Date.now() / 1000 - process.uptime() - btime;
    if (!(ticks > 0) || !(bootSeconds > 1) || !Number.isFinite(btime)) return null;
    const hz = Math.round(ticks / bootSeconds);
    return hz === 100 || hz === 250 || hz === 1000 ? hz : null;
  } catch {
    return null;
  }
};

// Does the process currently owning `pid` plausibly match the lock's
// recorded start time? True means "cannot rule out the real owner" —
// including every case where the check cannot run (non-Linux, unreadable
// /proc, legacy lock without startedAt, garbage input): the safe direction
// is to keep refusing the boot, exactly the old behavior.
export function processStartMatches(pid, startedAtIso) {
  if (typeof startedAtIso !== "string" || !startedAtIso) return true;
  const hz = clockTickHz();
  if (!hz) return true;
  let startMs;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[PROC_STAT_STARTTIME_INDEX]);
    const btime = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    if (!(ticks >= 0) || !Number.isFinite(btime)) return true;
    startMs = (btime + ticks / hz) * 1000;
  } catch {
    return true;
  }
  const recordedMs = Date.parse(startedAtIso);
  if (!Number.isFinite(recordedMs)) return true;
  return Math.abs(startMs - recordedMs) <= PID_START_TOLERANCE_MS;
}

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
    if (existing && pidAlive(existing.pid) && processStartMatches(existing.pid, existing.startedAt)) {
      throw lockError("instance_lock_held",
        `another project-room instance holds this database (pid ${existing.pid}, started ${existing.startedAt ?? "unknown"}); refusing to boot`);
    }
    // Stale, malformed, or PID-recycled lock: reclaim exactly once. If a racing process
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
