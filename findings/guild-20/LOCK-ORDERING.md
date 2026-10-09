# Lock ordering & deadlock avoidance

## There is (almost) no lock ordering problem

The design sidesteps classic lock-ordering by having **exactly one lock that can be held across
statements**: SQLite's database write lock, always taken as `BEGIN IMMEDIATE` (RESERVED) at
transaction start and released at COMMIT/ROLLBACK. Consequences:

- **No two-lock ordering**: a transaction never acquires a second lock while holding the first.
  The instance file lock is taken once at boot and held for the process lifetime (never acquired
  inside a DB transaction). The permit row and writer-fence triggers are *inside* the DB
  transaction, not separate locks. The merge-slot queue is in-process only.
- **No lock upgrades**: `BEGIN IMMEDIATE` takes RESERVED up front, so a transaction never upgrades
  SHARED→RESERVED mid-flight — the classic SQLite deadlock shape is structurally absent from
  `store.transaction`. (The M-09 mutant, deferred `BEGIN`, reintroduces exactly this hazard:
  two concurrent read-modify-write transactions deadlock on upgrade and one eats `SQLITE_BUSY`.)
- **Nesting is re-entrant, not stacked**: `store.transaction` inside an active transaction just
  runs `fn()` (no new `BEGIN`). There is no nested-lock acquisition to order. The `isolated: true`
  path uses a single named savepoint (`room_isolated_write`), never nested savepoints.

## What prevents hangs

- `busy_timeout=3000`: a contended `BEGIN IMMEDIATE` waits 3s, then throws `SQLITE_BUSY` instead
  of hanging forever. Callers treat it as a storage failure (503 path), not a retry loop.
- Transactions are **short and synchronous**: the `isolated` guard refuses async functions inside
  transactions ("Room transactions must remain synchronous"), so a transaction can never be held
  across an event-loop turn. No `await` inside any critical section — verified structurally for
  `createMergeSlotQueue`, `transitionReplyUpdate`, the identity mint, and the wake lease.
- The sweep's GitHub fetch happens **before** the transaction opens (never holds the write lock
  over network I/O).
- `WAL` mode: readers never block writers, writers never block readers. A writer blocks only
  another writer, and only for the transaction's duration.

## The one place ordering still matters: boot

`server.mjs` takes the instance file lock **before** opening the database. If it were reversed
(DB open → migrations take locks → then file lock), two racing boots could deadlock against
each other's migration transactions while both wait on the file lock. Current order (file lock
first) is correct — do not reorder. (`server.mjs:43`: `paused ? null : acquireInstanceLock(lockPath)`;
the `paused` bypass exists for tooling that must open the DB without the singleton guarantee —
it must never be used by a serving instance.)

## Deadlock checklist for future code

1. Never `await` between `BEGIN` and `COMMIT`.
2. Never take the instance file lock inside a DB transaction.
3. Never nest `BEGIN IMMEDIATE` (rely on the re-entrant `store.transaction`).
4. Keep write transactions short; move network I/O before or after, never inside.
5. If you add a second lock, document its order relative to the DB write lock here.
