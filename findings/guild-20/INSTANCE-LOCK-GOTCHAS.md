# instance-lock gotchas (`server/instance-lock.mjs`)

## 1. The protocol is not atomic — double-hold is proven (see `RACE-instance-lock-double-hold.md`)

`openSync("wx")` → `writeSync` are two syscalls; a racer hitting `EEXIST` between them reads an
empty file, calls it "malformed → stale", unlinks the live creator's lock, and acquires too.
The stale-reclaim path (`unlinkSync` → re-`create`) has the same hole: two racers can interleave
unlink/create so the loser deletes the winner's fresh lock — 188/200 double-holds in testing.
The lock's whole purpose (one server per DB) is defeated by its own reclaim. Fix direction:
`link(2)`-based acquisition (atomic, exactly one winner) or an `flock`/`fcntl` OFD lock.

## 2. PID-liveness has two failure modes

- **PID reuse**: `pidAlive` uses `kill(pid, 0)`. If the OS recycles the dead holder's PID to an
  unrelated live process, every future boot refuses with `instance_lock_held` forever — a
  liveness failure requiring manual lock-file deletion. (No `startedAt` sanity check is done.)
- **EPERM means alive**: in containers with mixed UIDs, a live foreign-owned PID reads as "held"
  — correct direction (fail closed), but the error message doesn't say whose process it is.

## 3. `release()` can unlink someone else's lock

`release()` does `closeSync(fd)` + `unlinkSync(lockPath)` unconditionally. If a racing boot
reclaimed the path between our crash... no — reclaim requires our PID dead. The real case:
**we are the double-hold loser** (see #1): our `release()` unlinks the *winner's* live lock file
on graceful shutdown. The code comment acknowledges it ("a racing boot may have reclaimed;
shutdown must not throw") but the consequence is the winner now runs lockless.

## 4. The `paused` bypass (`server.mjs:43`)

`paused ? null : acquireInstanceLock(lockPath)` — tooling can open the DB without the singleton
guarantee. Safe only for offline/read-only tools. A serving instance must never run paused;
there is no runtime check that it doesn't.

## 5. Malformed ≠ stale, but the code treats them identically

Any `JSON.parse` failure (empty file, partial write, disk corruption) → "stale, reclaim".
After a fix for #1, the reclaim path should distinguish "empty and brand-new" (wait/retry, a
live creator is mid-write) from "parseable but dead PID" (reclaim) from "parseable garbage"
(operator attention). The existing test "a malformed lock file is reclaimed, not fatal" pins
the current behavior — it will need updating with the fix.

## 6. `0o600` and stale NFS handles

The lock file is created `0o600` — correct. On NFS, `unlink`+`create` reclaim can hit stale
file handles; the `instance_lock_io` code covers it, but the message doesn't distinguish
"lost the reclaim race" (benign, retry boot) from "disk error" (operator attention).
