# server/work-claim-sqlite.mjs — durable work-claim registry

Production `RoomStore` owns this registry; HTTP and next-actions share it.
Claims, leases, and review attestations survive Worker eviction and
deployment. The Map registry (work-claim-routes.mjs) remains a fixture for
isolated state-machine tests.

## Storage model

Items are stored **whole as JSON** (`item_json`), keyed `(room_id,
claim_id)`. Rows pass through `workOf` validation on read (via decode), so
a row is never trusted without the state machine — unknown fields dropped,
missing fields take `WORK_CLAIM_DEFAULTS`, so rows written by older code
(plain JSON, no envelope) still load (`decodeRow` with
`WORK_CLAIM_ROW_KIND = "work-claim"`).

`verifySchema()`: compares the live table shapes against `workClaimSchema`
(normalized); mismatch throws `"Work-claim schema requires operator
reconciliation"` — fail-closed, never auto-migrates.

## API (`createDurableWorkClaimRegistry(db, {now, transaction, onChange})`)

- `get(roomId, id)` / `has` / `list` (rowid order) / `set` (upsert +
  `onChange(roomId)`) / `delete(roomId, id)`.
- `configure(roomId, config)` / `configFor(roomId)` / `rawConfig(roomId)` —
  config JSON merged and resolved through `roomWorkClaimConfig`.
- `db` needs only `prepare` → `{get, all, run}` (node:sqlite compatible).
  Statements are prepared lazily — `RoomStore` constructs services before
  its atomic schema migration.

## Delete semantics (#1527)

`delete` waives the deleted id from every dependent's `dependsOn` before
removing the row. Rationale: `readyClaims` treats a missing dependency as
"not done", so a claim depending on a deleted claim could never return to
`queue=ready` — stranded, ownerless, invisible. The land-queue delete paths
already emit a deletion receipt naming the dependents, so the waiving is
visible, not silent.

## Crash safety (fuzz-pinned, 2026-10-09)

`kill -9` mid-upsert (after a 60-upsert handshake proves the writer is
mid-write): `PRAGMA integrity_check` → ok, every row decodes, no torn JSON.
Single-statement upserts are atomic.

## Gotchas

- `set` requires `item.id` to be a string (`TypeError` otherwise) but does
  not run `workOf` — validation happens on read paths and at the routes.
- `transaction` defaults to pass-through; callers (RoomStore) supply the
  real transaction so claim + event commit together.
- **Performance note (2026-10-09):** the workspace disk fsyncs at ~160ms per
  upsert (vs tmpfs). Test suites should keep using worktree-local TMPDIR,
  but expect slower durable-registry tests there than on tmpfs.
