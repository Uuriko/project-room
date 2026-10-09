# server/store.mjs — RoomStore

The single durable-state owner for Project Room. One SQLite file per deployment
(`RoomStore(file)`), schema version 38 (`STORE_SCHEMA_VERSION` in
server/writer-fence.mjs), migrated stepwise from version 0. ~5300 lines.

## Storage layout

- **rooms** — `id TEXT PRIMARY KEY, sequence INTEGER, projection TEXT (JSON), archived_at TEXT`.
  The projection is the cached reducer output; the event log is the source of truth.
- **events** — `(room_id, sequence, id UNIQUE, body TEXT)`, `PRIMARY KEY(room_id, sequence)`.
  Append-only; `body` must be valid JSON (enforced by the writer fence — a raw
  `UPDATE events SET body='{{{not-json'` throws `malformed JSON`; verified by fuzz F1).
- **commands** — idempotency records keyed `(room_id, actor_id, id)`, FK to events.
- **projection_checkpoints** — `(room_id, sequence, projection)` snapshots that bound
  rebuild cost; rebuild replays only events after the checkpoint.
- **accounts / member_accounts / account_credentials / account_access_events** —
  identity and session state.
- **membership_invitations / membership_invitation_events / membership_invitation_journal** —
  invite lifecycle; journal is append-only (BEFORE UPDATE/DELETE triggers RAISE(ABORT)).
- **integrity_snapshot / integrity_room_state / integrity_job_cursor** — rolling
  integrity sweeps. **The checksum covers rooms, projection bytes, and invitation
  rows — NOT the event log** (`integrityChecksum`: "Rooms, projection bytes, and
  invitation rows. Not the event log."). A semantically-corrupt (valid-JSON) event
  body is invisible until `rebuildProjection` runs — verified by fuzz F1.
- **work_claims / work_claim_config** — durable claim registry (see work-claim-sqlite.md).
- Many feature tables (room_directory_settings, assistant_runs, attachments, …).

## Transactions

`store.transaction(fn, { readOnly })`:
- Write txns take `BEGIN IMMEDIATE` (not deferred BEGIN) so the write lock is
  acquired up front — concurrent writers get SQLITE_BUSY instead of a mid-txn
  upgrade failure.
- `PRAGMA busy_timeout=3000` — lock waits up to 3s before failing.
- `PRAGMA synchronous=FULL`, `journal_mode=WAL` — durability over speed.
- Nested writes run under `SAVEPOINT room_isolated_write` with rollback-to-savepoint
  isolation; a failed isolated write poisons the parent (`nodeFailedIsolations` —
  "Cannot commit after isolated transaction rollback failed").
- Read txns take `BEGIN` + `PRAGMA query_only=ON`.
- **Mutation finding (S4)**: dropping the `COMMIT` passes the whole suite — no test
  detected uncommitted writes. Fail-first regression in
  `findings/guild-04/regressions/reg-survived-mutants.test.js`.

## Event log semantics

- Sequences are dense per room, starting at 1. Rebuild (`_replayRoom`) throws
  `"Event sequence is not contiguous"` on any gap and
  `"Event sequence does not reach the room projection"` when the head is short.
- `initialize(events)` is an administrative bootstrap (never over HTTP).
- `rebuildProjection(roomId, through)` replays from the checkpoint to `through`;
  used by historical-room reads.
- Duplicate `(room_id, sequence)` is rejected by the PRIMARY KEY (fuzz F2).

## Recovery behavior

- Cold start runs schema migration, then `verifyRoomLifecycle` (archived_at column
  must agree with every projection), then per-service `verifySchema` calls.
- `PRAGMA quick_check` / `integrity_check` surface page-level corruption.
- WAL corruption: SQLite ignores frames with bad checksums and recovers to the
  pre-WAL state — verified by fuzz F6 (reopen after WAL byte-flips: no torn data).
- Disk-full (`ulimit -f`): writes throw `ERR_SQLITE_ERROR`, never hang; the file
  reopens clean — verified by fuzz F5.

## Gotchas

- The writer fence (`project_room_writer_v38`, server/writer-fence.mjs) is a SQLite
  function + triggers registered on the store's connection: it validates JSON and
  blocks writes to fenced tables. Raw SQL on a *second* connection bypasses it —
  but also bypasses the `project_room_writer_v38` function itself (triggers fail
  with "no such function").
- `integrityChecksum` deliberately excludes the event log — do not assume the log
  is checksummed.
- `initialize()` is not idempotent-safe for production use; it is test/admin only.
