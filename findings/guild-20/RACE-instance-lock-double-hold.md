# BUG CONFIRMED — instance-lock double-hold (two interleavings)

**File:** `server/instance-lock.mjs` — `acquireInstanceLock`, the create/write and stale-reclaim paths
**Severity:** high (safety property violation: the module's entire purpose is "one server per database")
**Status:** reproduced deterministically + probabilistically; fail-first repro scripts in `race-hunt/`

## What the lock promises

Header comment: "The lock is an exclusive-create file next to the database holding the owner's PID;
a stale lock (dead PID or malformed content) is reclaimed exactly once."

## Interleaving 1 — empty-file reclaim (deterministic; `race-hunt/rh01-instance-lock-double-boot.mjs`)

`acquireInstanceLock` does `openSync(lockPath, "wx")` and *then* `writeSync(fd, payload)` as two
separate steps. A racing boot that hits `EEXIST` in between reads an EMPTY file, `readLock` returns
null ("malformed"), and the racer treats the live creator's lock as stale: `unlinkSync` + re-create.

1. A: `openSync(lockPath, "wx")` → fd_A (file exists, empty)
2. B: `openSync` → EEXIST → `readLock` → empty → null → `unlinkSync` (deletes A's file!) → `openSync` → fd_B → `writeSync` → **B returns "acquired"**
3. A: `writeSync(fd_A, ...)` → succeeds on the unlinked inode → **A returns "acquired"**

Result: A and B both hold the lock → two `server.mjs` on one database → torn growth-snapshot writes
(the exact hazard the module exists to prevent). Reproduced: `RH-01 RESULT: RACE CONFIRMED`.

## Interleaving 2 — stale-reclaim unlink race (188/200 rounds; `race-hunt/rh02-instance-lock-reclaim-race.mjs`)

The reclaim path (`unlinkSync` then re-`create`) is not atomic. Two boots racing a stale lock:

1. A: EEXIST → read stale → `unlinkSync` ok → `openSync` ok → fd_A
2. B: EEXIST → read stale → `unlinkSync` ok (**deletes A's fresh lock file**) → `openSync` ok → fd_B
3. Both `writeSync` and return "acquired" → **double hold**

The code comment only guards the narrower case ("a racing process grabbed it between our unlink and
re-create"); it misses the loser unlinking *after* the winner's re-create. 200 rounds, 2 concurrent
boots per round: **188 double-holds**, 0 both-refused.

## Why the existing tests miss it

`tests/instance-lock.test.js` covers single-process behavior only ("a stale lock is reclaimed",
"a malformed lock file is reclaimed"). No test exercises two concurrent acquirers.

## Fix direction (not applied — reporting per slice rules)

The file protocol needs one atomic primitive instead of create→write / unlink→create sequences.
Options: `link(tmpfile, lockPath)` (atomic; exactly one winner; loser reads the winner's fully-written
file), or an `flock(2)`/`fcntl` OFD lock on the lock file. At minimum, a re-read-and-verify after
create narrows but does not close the window.

## Repro

```
cd ~/workspace/pr-wave1000-guild-20
REPO=$PWD TMPDIR=$PWD/.tmp node race-hunt/rh01-instance-lock-double-boot.mjs  # deterministic
REPO=$PWD TMPDIR=$PWD/.tmp ITERS=200 node race-hunt/rh02-instance-lock-reclaim-race.mjs
```
