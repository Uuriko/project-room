# Suspected bugs: public-work-claim-fence.mjs (WAVE-400)

Read-only review at origin/main c5d1c313a. Not fixed, per assignment.

## Suspected bugs

- `server/public-work-claim-fence.mjs:37` — entry check `get()?.enabled !== 0` treats an absent
  permit table (get() → undefined) as "already open", throwing the misleading
  `'Public claim writer permit must be closed before entry'` instead of a "schema not installed"
  error.
- `server/public-work-claim-fence.mjs:36-37` (+ `server/public-work-claims.mjs:152,238`) —
  `act()` opens the permit and calls `apply()`; if that act input carries `autoClaim: true`,
  `apply()` calls `withPublicWorkClaimWriter` again and the nested entry check throws
  `'Public claim writer permit must be closed before entry'`. The wrapper cannot nest, so the
  auto-claim path inside an already-permitted act() is unusable.
- `server/public-work-claim-fence.mjs:10-14` — every trigger's `WHEN` clause queries
  `public_work_tasks`; if that table is dropped while the triggers remain, any write to
  `work_claims`/`work_claim_config` fails with a raw `no such table: public_work_tasks`
  SQLITE_ERROR rather than the fence's `unsupported public claim writer` abort (or passing through
  for private namespaces). The triggers have no defensive existence check.
- `server/room-export.mjs:292-308` — replay opens the permit (`enabled=1`) then closes it in the
  same transaction body with raw SQL, not in a `finally`. If a row insert throws *and* the
  transaction wrapper fails to roll back cleanly (e.g. a failed statement left the transaction
  committed in a partial state), the close never runs and the permit could be left open. Lower
  severity than the fence's own path, which closes in `finally`.

## What was checked

- All six trigger SQL strings: `WHEN` scopes (INSERT→NEW, DELETE→OLD, UPDATE→OLD OR NEW),
  the `COALESCE((SELECT enabled ...),0) IS NOT 1` gate, and the `RAISE(ABORT, 'unsupported public
  claim writer')` — all correct; allow-by-default only applies to non-public namespaces, which is
  the documented intent ("not authentication"), not a bug.
- `withPublicWorkClaimWriter` finally/`isTransaction` interplay: on `fn` throw, the reset UPDATE
  runs inside the still-open transaction before the wrapper rolls everything back, so the permit
  returns to 0; on I/O-caused auto-rollback the `isTransaction` check skips the redundant reset —
  consistent.
- `verifyPublicWorkClaimFence`: normalization (whitespace/`;`/`IF NOT EXISTS` stripping) verified
  against `CREATE TRIGGER IF NOT EXISTS` statements stored in `sqlite_master`; `allowAbsent` returns
  `false` only when *all* shapes are absent; the at-rest `(singleton=1, enabled=0)` single-row check
  is correct.
- Caller audit (`store.mjs`, `public-work-claims.mjs`, `room-export.mjs`, `operator-purge.mjs`,
  `cloudflare/public-work-claims.check.mjs`, `writer-fence.mjs`) for missing verify/open/close calls —
  store boot covers install + verify; the raw-SQL permit manipulation in room-export/operator-purge
  is deliberate but drifts from the module's contract (noted as gotcha in the module doc).
- The `INSERT OR IGNORE INTO public_work_claim_writer_permit ... VALUES(1,0)` seed re-run in the
  schema string is idempotent — no bug.
