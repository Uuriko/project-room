# public-work-claim-fence.mjs — module doc (WAVE-400)

Source: `server/public-work-claim-fence.mjs` (47 lines). Schema-installable fence guarding
**public** work-claim writes.

## Purpose

Defines a SQLite permit table (`public_work_claim_writer_permit`, single row, `enabled` 0/1) plus six
BEFORE INSERT/UPDATE/DELETE triggers on `work_claims` and `work_claim_config` that abort with
`'unsupported public claim writer'` when a write touches a public namespace while the permit is closed.
It is a transactional write-permit, not authentication — the header comment says this explicitly.
Private claim namespaces keep their own rules and are untouched by the triggers.

## Public API

- `publicWorkClaimFenceSchema: string` — full DDL for the permit table, the six guard triggers, and an
  idempotent `INSERT OR IGNORE ... (singleton=1, enabled=0)` seed. Executed at store install/migrate
  (`server/store.mjs:1679`).
- `verifyPublicWorkClaimFence(db, { allowAbsent = false }): boolean` — throws
  `'Public claim writer fence requires operator reconciliation'` if any of the 7 schema objects
  (permit table + 6 triggers) differ from the canonical SQL after normalization; throws
  `'Public claim writer permit must be closed at rest'` unless the permit table holds exactly one row
  `(singleton=1, enabled=0)`. With `allowAbsent: true` returns `false` when the whole fence is absent.
- `withPublicWorkClaimWriter(store, fn): any` — runs `fn` synchronously inside `store.transaction`
  with the permit opened (`enabled=1`) and restored to `enabled=0` in a `finally` (skipped if the
  transaction is already gone). Throws on entry if the permit is already open, and rejects async `fn`
  (`'Public claim transactions must remain synchronous'`).

## Allows / denies

- **Allows:** any write (INSERT/UPDATE/DELETE) to `work_claims` / `work_claim_config` when (a) the
  affected row's `room_id` is **not** registered in `public_work_tasks.namespace_key` (private
  namespace — triggers don't fire), or (b) the permit row is open (`enabled=1`).
- **Denies:** any such write touching a public namespace while the permit is closed — trigger raises
  ABORT `'unsupported public claim writer'`.
- Writes to the other public-work tables (`public_work_tasks`, `public_work_requests`,
  `public_work_receipts`) are not fenced; they are registered in `writer-fence.mjs` instead.
- The fence gates *writers*, not readers — nothing here restricts SELECTs.

## Invariants

1. Permit is a single row `(singleton=1, enabled=0)` **at rest**; `enabled=1` exists only inside a
   `withPublicWorkClaimWriter` transaction (or the room-export replay / operator-purge equivalents).
2. All 7 schema objects must match the canonical definitions byte-for-byte after whitespace/`;`/`IF NOT EXISTS`
   normalization — `verifyPublicWorkClaimFence` throws otherwise (fail-closed).
3. INSERT fires when NEW's `room_id` is a public namespace; DELETE fires on OLD; UPDATE fires when
   OLD **or** NEW is a public namespace — so moving a claim across the public/private boundary is
   always gated.

## Top callers

- `server/store.mjs` — installs `publicWorkClaimFenceSchema` and verifies it on boot/migrate
  (lines 1057, 1275, 1677–1681; uses `{ allowAbsent: true }` for pre-fence backups).
- `server/public-work-claims.mjs` — wraps `enable()`, `act()` (lines 122, 152) and auto-claim writes
  (line 238) in `withPublicWorkClaimWriter`.
- `cloudflare/public-work-claims.check.mjs` — scenario check verifies the fence and exercises the
  fault path (lines 41, 45).
- `server/room-export.mjs` — bulk replay opens/closes the permit with **raw SQL**, bypassing
  `withPublicWorkClaimWriter` (lines 283–308).
- `server/operator-purge.mjs` — same raw-SQL pattern for operator purges (lines 401–402, 437).

## Gotchas

- **No nesting:** `withPublicWorkClaimWriter` cannot nest — the entry check throws
  `'Public claim writer permit must be closed before entry'`. Consequence: in
  `server/public-work-claims.mjs`, `act()` (line 152) already holds the permit open, so an `act()`
  call whose input has `autoClaim: true` hits the nested guard in `apply()` (line 238) and throws
  that entry error instead of nesting.
- **Absent-schema error message:** if the permit table doesn't exist, the entry check's
  `get()?.enabled !== 0` evaluates `undefined !== 0` → true, so it throws `'must be closed before
  entry'` — a misleading message for "schema not installed".
- **`normalize()` strips every occurrence of `IF NOT EXISTS`** (`/g`) during verification; harmless
  today since no name contains that substring.
- Trigger scope depends on `public_work_tasks` existing (see bugs file).
- `room-export.mjs` and `operator-purge.mjs` duplicate the permit open/close logic with raw SQL, so
  they don't get the sync-only guard or the `isTransaction` finally pattern — drift risk if this
  module's contract changes.
- The seed `INSERT OR IGNORE ... VALUES(1,0)` runs on every schema exec but is idempotent; it never
  re-opens an existing row.

## Stale comments

None found. The header comment ("not authentication against a database administrator … private
claim namespaces keep their rules") matches current behavior, and the `finally` comment about a
possible already-rolled-back transaction accurately describes the `isTransaction` check.
