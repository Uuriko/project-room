# server/store.mjs — part A (lines 1–1750): boot, storage platform, command shapes

`store.mjs` is the central `RoomStore`: SQLite-backed event-sourced room
state. Part A covers module wiring, the storage platform (WAL, transactions,
storage-failure classification), boot-time repair, the command shape table,
and the start of the `RoomStore` constructor.

## What this range contains

- **Import block (~130 lines)**: the module dependency map of the whole
  server — every sub-store (`Xxx` class + `xxxSchema`) is constructed in the
  `RoomStore` constructor below. Also re-exports `ServiceError` from
  `service-error.mjs` so every `import { ServiceError } from "./store.mjs"`
  resolves to the same class object (`instanceof` stays correct).
- **`StorageUnavailableError` / `isStorageUnavailable`**: exhausted or
  unwritable storage (SQLITE_READONLY/IOERR/FULL/CANTOPEN, ENOSPC/EDQUOT/EROFS/
  EIO, or matching driver text) becomes one typed 503 refusal with
  `Retry-After: 30`. `STORAGE_FAILURE_THRESHOLD` (3) consecutive failures trip
  readiness to 503; the next committed write recovers.
- **`ensureDefaultChannelState`**: legacy projections pre-channels gain
  `#general`, so stored projection, checkpoint, and fresh replay agree (a
  disagreement fails `auditRecovery`, which gates `backupRoom`).
- **Provenance repair** (`repairInvalidSupersessions`, `applyProvenanceRepair`):
  open-time repair that backfills `proposedById`, receipt/verification
  provenance, invalidates unconfirmable approvals (with `decisionHistory`
  entries), and fixes supersession cycles/dangling links. Mutates state, runs
  at open.
- **`PILOT_LIMITS`**: the bounded pilot caps in one place —
  `eventsPerRoom: 1_000_000` (the 10,000-event *lifetime* ceiling is enforced
  elsewhere; this is the per-room event cap), `membersPerRoom: 100`,
  `workItemsPerRoom: 500`, `projectionBytes: 4 MiB`. Raised 2026-10-06 per the
  owner's word (muse-room hit 82% of projection). Guard: keep the application
  guard at 4 MiB; bodies-at-rest supplies headroom.
- **`nodeStorage`**: `configure` (busy_timeout *before* journal_mode — a
  contended concurrent open used to throw SQLITE_BUSY), `transaction`
  (BEGIN IMMEDIATE for writes; read-only uses `query_only`; isolated writes
  via SAVEPOINT with full-rollback on savepoint failure; never double-ROLLBACK
  after SQLITE_FULL).
- **`COMMAND_TYPES` / `shapes`**: the classified command surface — every
  event type maps to its allowed field list. `validateCommand` enforces it;
  unknown types suggest the closest real ones.
- **`ProjectionCache`**: tiny LRU-ish cache of room projections by
  (roomId, sequence) with a byte budget.
- **`RoomStore` constructor** (starts :1156, continues past :1750):
  validates options (`integrity` eager|deferred, stitch triple shape),
  constructs ~60 sub-stores, checks the schema version is in the contiguous
  range 0..STORE_SCHEMA_VERSION (a hand-maintained list once dropped v26 and
  500'd rooms still on it — hence the range check), and opens with cold-start
  logging to stderr (stdout's first write means "listening").

## Invariants

- Room transactions must remain synchronous (`isolated` writers that return a
  promise throw).
- A write inside a read-only transaction throws; the read marker is a WeakSet
  on the db handle.
- Schema versions are a contiguous range — never a hand-maintained list.
- `RETIRED_BOARD_V2_SCHEMA` tables stay forever: existing databases and the
  recovery audit still see them; nothing drops `board_vtwo_*`.

## Gotchas

- The constructor is ~700 lines; sub-store construction order matters only
  where schemas have cross-dependencies (fences installed after tables).
- `logColdStart` deliberately avoids `COUNT(*) ON events` for deferred opens
  (must not walk the event log); sequence sums + projection bytes are the
  state-size signal.
- `applyProvenanceRepair` mutates the passed state in place and returns
  whether anything changed — callers persist on `true`.

## Stale comments

None found in this range — the comments carry real history (QA slice D,
RC numbers, the v26 500 incident, G11) and match the code.
