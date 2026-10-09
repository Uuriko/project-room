# server/work-claim-sqlite.mjs — durable work-claim registry

Production claims survive Worker eviction and deploys; the in-memory Map registry
remains only as a fixture for isolated state-machine tests.

## Row format

Items are stored whole as JSON in `work_claims(room_id, claim_id, item_json, updated_at)`
with `PRIMARY KEY(room_id, claim_id)`. Rows carry a version envelope
(`encodeRow`/`decodeRow` in server/persisted-row.mjs, kind `"work-claim"`):
- Unknown fields are **dropped** on read; missing fields take `WORK_CLAIM_DEFAULTS`.
- Legacy rows (plain JSON, no envelope) still load — defaults fill the gaps.
- `title` falls back to `id` when null (`decodeItem` — "workOf: title ?? id").
- `historyOmitted` / `deploy` counters are deleted when null (sparse fields).

## API (`createDurableWorkClaimRegistry(db, { now, transaction, onChange })`)

- `set(roomId, item)` — upsert (`ON CONFLICT DO UPDATE`); requires `item.id`.
- `get(roomId, id)` — decoded item or null.
- `list(roomId)` — **insertion order** (`ORDER BY rowid ASC`). Mutation finding (W4):
  reversing to DESC passed the whole suite — no test asserted ordering until the
  guild-04 regression test.
- `has(roomId, id)`, `delete(roomId, id)`.
- `verifySchema()` — the stored DDL must match `workClaimSchema` exactly (normalized),
  else "Work-claim schema requires operator reconciliation".

## delete() dependency waiving (#1527)

`readyClaims` treats a missing dependency as "not done", so deleting a claim its
dependents still reference would strand them ownerless and invisible. `delete()`
therefore rewrites every dependent's `dependsOn`, dropping the deleted id, and the
land-queue paths emit a deletion receipt naming the dependents — the waiving is
visible, not silent. Mutation finding (W1): inverting the waive filter passed the
suite; regression test added.

## Concurrency

- 5 processes × 50 concurrent `set()`s: zero lost writes, zero torn rows
  (fuzz F3, WAL + busy_timeout=5000).
- Duplicate delivery is idempotent; `list()` decodes every row (fuzz F4).

## Invariants

1. Default claim state is `"unclaimed"` (mutation W5: flipping to `"claimed"`
   passed the suite — regression test added).
2. `list()` order is insertion order (rowid ASC).
3. Deletes never strand dependents (waive rule).
4. Schema shape is pinned — drift throws instead of migrating silently.
