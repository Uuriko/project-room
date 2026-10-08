# work-claim-sqlite.mjs — durable work-claim registry (SQLite)

Source: `server/work-claim-sqlite.mjs` (134 lines) at origin/main c5d1c313a.

## Purpose

SQLite persistence layer for the work-claim state machine. In production, `RoomStore`
owns it (`store.workClaims`) and HTTP + next-actions share the same registry. Claims,
leases, and review attestations survive Worker eviction and deployments.

Claim items are stored whole as JSON wrapped in a replay-safe envelope (`persisted-row.mjs`).
Rows are never trusted on read: each is decoded through a field allowlist + defaults and
then validated by the state machine (`workOf()` in `work-claims.mjs`).

## Schema / tables touched

Exported as `workClaimSchema` (applied by `store.mjs` migration, `db.exec(workClaimSchema)`):

- `work_claims (room_id TEXT, claim_id TEXT, item_json TEXT, updated_at INTEGER)` —
  `PRIMARY KEY (room_id, claim_id)`. One row per claim per room; whole item as JSON.
- `work_claim_config (room_id TEXT PRIMARY KEY, config_json TEXT, updated_at INTEGER)` —
  per-room merged config (e.g. `defaultLeaseHours`, `maxMemberOpenClaims`).

Row envelope: `encodeRow(WORK_CLAIM_ROW_KIND, item)` → `{ v: 1, kind: "work-claim", data }`;
`decodeRow` drops unknown fields and applies defaults. `WORK_CLAIM_FIELDS` is a 40-field
allowlist mirroring `workOf()` output; `WORK_CLAIM_DEFAULTS` supplies missing fields
(`state: "unclaimed"`, `kind: "work"`, empty arrays/maps). After decode: `title ?? id`,
and `historyOmitted` / `deploy` are pruned when null (sparse-field convention).

## Public API

- `WORK_CLAIM_ROW_KIND` — `"work-claim"`; the envelope tag checked on every read.
- `workClaimSchema` — the DDL string above; fail-closed verified against `sqlite_master`.
- `createDurableWorkClaimRegistry(db, { now = Date.now, transaction = fn => fn(), onChange = null })`
  — throws `TypeError` unless `db.prepare` is a function. Returns:
  - `transaction` — passthrough of the injected wrapper (RoomStore wires `fn => this.transaction(fn)`).
  - `verifySchema({ allowAbsent = false })` — compares the DDL in `sqlite_master` against
    `workClaimSchema` after normalizing whitespace/`IF NOT EXISTS`/trailing `;`. Throws
    `"Work-claim schema requires operator reconciliation"` on drift; returns `false` when
    `allowAbsent` and both tables are missing; `true` otherwise.
  - `get(roomId, id)` — decoded item or `null`.
  - `set(roomId, item)` — upsert (`ON CONFLICT` on the PK). Throws `TypeError` unless
    `item.id` is a string. Fires `onChange(roomId)` after the write. Returns `item`.
  - `list(roomId)` — all decoded items in `rowid` (insertion) order.
  - `has(roomId, id)` — boolean existence check.
  - `delete(roomId, id)` — removes the row; first waives the deleted id out of every
    dependent's `dependsOn` (see Invariants). Fires `onChange(roomId)` once.
  - `configure(roomId, config)` — merges `config` over the stored JSON and returns
    `roomWorkClaimConfig(...)`; with `undefined`/`null` config it is a read-only call.
    Throws unless config is a plain object.
  - `configFor(roomId)` — merged, normalized config via `roomWorkClaimConfig`.
  - `rawConfig(roomId)` — shallow copy of the stored raw config JSON.

## Transaction / locking behavior

- The module opens **no transactions itself**. Atomicity is delegated: multi-step callers
  wrap with the injected `transaction` — e.g. `claim-autolink.mjs`, `claim-pr-sync.mjs`,
  and `land-queue.mjs` (`this.store.transaction(() => { ... this.store.workClaims.delete(...) ... })`).
  RoomStore wires `transaction: fn => this.transaction(fn)` (`store.mjs:1198`).
- Statements are prepared **lazily per call** (`statement()` helper calls `db.prepare` on every
  `get`/`all`/`run`) because RoomStore constructs services before its atomic schema migration.
- Locking comes from the store layer: `PRAGMA busy_timeout=3000`, `journal_mode=WAL`,
  `synchronous=FULL`, `foreign_keys=ON` (`store.mjs:641-642`). No `query_only` involvement here —
  the registry is constructed the same way for read-only handles; writes on a read-only db
  fail at SQLite level.

## Invariants

1. **Never trust a row**: every read goes through `decodeRow` (unknown fields dropped,
   missing fields defaulted) and callers pass results through `workOf()` validation.
2. **No stranded dependencies**: `delete` removes the deleted id from every dependent's
   `dependsOn` (#1527) — ready-claims treats a missing dependency as "not done", so without
   the waiver a dependent could never return to queue=ready. Land-queue delete paths emit a
   deletion receipt naming the dependents, so the waiver is visible.
3. **Schema fail-closed**: `verifySchema()` throws on DDL drift instead of silently
   tolerating a changed table shape (partial absence also throws; only all-absent +
   `allowAbsent` returns `false`).
4. **All SQL is parameterized** (`?` placeholders only); table/column names are literals —
   no injection surface from caller-supplied `roomId`/`claimId`.
5. **Config merge is last-write-wins JSON merge**, not a diff; `configure` re-reads the stored
   config, spreads, and upserts.

## Top callers

| Caller | What it uses |
|---|---|
| `server/store.mjs` | constructs `this.workClaims`, runs `db.exec(workClaimSchema)` in migration, `verifySchema` ×3 |
| `server/land-queue.mjs` | `get/set/has/delete`, `configFor` (maxMemberOpenClaims), `transaction` wrappers |
| `server/claim-pr-sync.mjs` | `get/list/set` inside `transaction` for expiry + PR-state sync |
| `server/claim-autolink.mjs` | `list/set` inside `transaction` for PR autolink |
| `server/public-work-claims.mjs` | `get/list/set` for public offers |
| `server/routes/work-claims.mjs` | `list` for the board page / retention report |
| `server/mcp-full-profile.mjs` | `configure` (set maxMemberOpenClaims) |
| `server/work-claim-mirror.mjs` | `set`, `configFor` / `rawConfig` fallback |
| `cloudflare/public-work-claims.check.mjs` | constructs its own registry on the worker db |

## Gotchas

- `configure()` is a **read-modify-write with no transaction**: `rawConfig` is read, merged in
  JS, then upserted. Two concurrent `configure` calls can lose one merge. `mcp-full-profile.mjs`
  calls it with no wrapping transaction.
- `delete()`'s waive-loop + `DELETE` is also non-atomic at this layer; it only becomes atomic
  when callers wrap it (`land-queue.mjs` does via `store.transaction`).
- The `statement` helper re-prepares SQL on every call — correct but wasteful; not a bug.
- `delete` does not refresh dependents' `updatedAt` when waiving (receipt covers visibility).
- `verifySchema` normalize strips `IF NOT EXISTS` before comparing; the regex extracting the
  table name (`/CREATE TABLE IF NOT EXISTS ([a-z_]+)/`) assumes the exported DDL keeps that
  exact form — editing the DDL's casing/prefix would break the check before the comparison runs.
- `parse()` throws on corrupt `config_json`; `get` would propagate a JSON parse error from a
  corrupt `item_json` (no try/catch) — corruption fails loudly, not silently.

## Stale comments

None found. Checked all three non-trivial comments against live code:
- Header "The Map registry remains a fixture for isolated state-machine tests" — still true:
  `createWorkClaimRegistry()` (Map-based) exists in `server/work-claim-routes.mjs:68`.
- "Prepare lazily: RoomStore constructs services before its atomic schema migration" — still
  true: `store.mjs` constructs `this.workClaims` (~line 1197) before the migration block
  (~line 1511) runs `db.exec(workClaimSchema)`.
- `delete()` #1527 comment ("land-queue delete paths already emit a deletion receipt naming
  the dependents") — still true: `land-queue.mjs` `remove()` and the pr-not-found path both
  call `#receiptClaimDeleted(roomId, { ..., dependents })` inside the same `store.transaction`.
