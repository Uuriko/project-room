# work-claim-sqlite.mjs — suspected bugs

Source: `server/work-claim-sqlite.mjs` at origin/main c5d1c313a.
DO NOT FIX — findings only, for WAVE-400 triage.

## Suspected

- `server/work-claim-sqlite.mjs:125-129` (`configure`) — read-modify-write of
  `work_claim_config` is not atomic: reads `rawConfig`, merges in JS, upserts. Two
  concurrent `configure` calls lose one merge. `mcp-full-profile.mjs:288` calls it with no
  wrapping transaction. Severity: low (config writes are rare and operator-initiated).
- `server/work-claim-sqlite.mjs:108-122` (`delete`) — the dependent-waive loop plus the
  final `DELETE` is non-atomic at this layer; a crash between waiving and deleting leaves
  dependents waived but the claim still present. `land-queue.mjs` wraps both its delete
  paths in `store.transaction`, so the current production callers are safe — the hazard is
  a future caller using `delete` directly.
- `server/work-claim-sqlite.mjs:115` — dependents waived by `delete` keep their old
  `updatedAt`; change-tracking consumers keyed on `updatedAt` won't see the waiver.
  (Mitigated: land-queue emits a deletion receipt naming the dependents.)

## Checked and clear

- **SQL injection**: all statements use `?` placeholders with caller values bound as
  parameters; table and column names are literals. No dynamic SQL anywhere in the file.
- **Busy-timeout**: not this module's job; `server/store.mjs:641-642` sets
  `PRAGMA busy_timeout=3000` (+ WAL, `synchronous=FULL`) on every db the registry can be
  constructed with.
- **Schema drift**: `verifySchema` fail-closes on DDL mismatch
  ("Work-claim schema requires operator reconciliation"); `store.mjs` runs it before and
  after `db.exec(workClaimSchema)` in the migration.
- **Missing-id writes**: `set` throws `TypeError` when `item.id` is not a string.
- **Non-object config**: `configure` rejects arrays/non-objects; `parse` rejects null,
  arrays, and non-object JSON from `config_json`.
- **Envelope/kind mismatch**: `decodeRow` throws on a wrong `kind` tag (misrouted/corrupt
  row); unknown fields are dropped, missing fields take current defaults — old plain-JSON
  rows (pre-envelope) still load.
- **Rowid ordering**: `list` uses `ORDER BY rowid ASC` (insertion order); no index needed
  for the PK lookups (`room_id, claim_id` is the PK).
