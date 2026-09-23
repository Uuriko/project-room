# Schema convergence gate

CI-time harness for the **bounty-propose-500 bug class** (production incident
2026-09-22, post-#792; fixed by #793).

## The bug class

`BountyEscrow._ensure()` treated "some tables missing" and "columns need
migrating" as either/or:

```js
if (needed.some(t => !tables.has(t))) this.db.exec(bountyEscrowSchema);
else this._migrateColumns();
```

A shard carrying the pre-#792 table set (no `bounty_rubric_versions` /
`bounty_flakes` / `bounty_review_packets` / `bounty_sybil_flags`) but an old
`bounty_records` (no `rubric_json` / `rubric_hash` / `rubric_version`) took the
first branch: the new tables were created, the old columns were never added,
and every propose INSERT then threw
`table bounty_records has no column named rubric_json` — while `SELECT`-based
reads kept working, which is exactly why it looked like a "some rooms" issue.

The general bug class: **a schema-convergence path that silently leaves a
partially-migrated shard behind**, where writes 500 but reads work.

## What the gate does

`scripts/schema-gate/schema-gate.mjs`:

1. **Builds simulated legacy shards** (a matrix of partial-migration states):
   - `incident-792` — the exact production state: pre-#792 table set + old
     `bounty_records` columns, plus one seeded legacy bounty row.
   - `columns-stale` — all tables present, every `_migrateColumns()` column
     missing.
   - `tables-missing` — converged columns, the 4 newer tables dropped.
   - `fresh` — empty DB (first-boot path; migration must be a safe no-op).
2. **Runs the current code's request-time `_ensure()`/migration path** against
   each shard — the same fallback path a request takes on an isolate where
   RoomStore boot convergence never ran (direct `BountyEscrow` construction,
   then `postBounty`, the request-path INSERT that 500'd).
3. **Fails the gate (exit 1)** if:
   - any request-path INSERT throws, or
   - the migrated shard is missing any table/column declared by the pristine
     schema — detected by diffing against an **oracle**: a fresh database
     built from the same exported `bountyEscrowSchema` DDL. This makes the
     gate future-proof: a new column added to the DDL that a future migration
     forgets to backfill fails the gate with no hardcoded column list to
     keep in sync.
   - reads stop working alongside writes, or a legacy row's rubric pin is
     left un-backfilled.

Usage:

```sh
node scripts/schema-gate/schema-gate.mjs [--codebase <dir>] [--only <row>] [--list]
```

- `--codebase <dir>` — test a different checkout's `server/bounty-escrow.mjs`
  (default: this repo). Used for the negative control below.
- `--only <row>` / `--list` — run or list a single matrix row.

## Proving it catches the bug class (negative control)

The gate must FAIL against the pre-#793 code and PASS on current main:

```sh
# 1. Pre-fix checkout (post-#792, pre-#793):
git worktree add /tmp/schema-gate-neg c08827a6^   # or any persistent dir
# 2. Run the NEW gate against the OLD code:
node scripts/schema-gate/schema-gate.mjs --codebase /tmp/schema-gate-neg
#    => FAIL incident-792:
#       - request-path INSERT failed: table bounty_records has no column named rubric_json
#       - silently skipped table migration: bounty_rubric_versions, ...
#       - silently skipped column migration: bounty_records.rubric_hash, ...
# 3. Run the gate against current code:
node scripts/schema-gate/schema-gate.mjs
#    => SCHEMA GATE: PASSED (4/4 rows)
```

Note the discrimination: on the pre-fix code only `incident-792` fails —
`columns-stale` and `tables-missing` pass because the old `else
_migrateColumns()` branch handled those states correctly. The gate catches
exactly the XOR state the incident produced.

## CI wiring

- Workflow: `.github/workflows/schema-gate.yml`
- Trigger: `pull_request` + `push` to `main` (same shape as `test.yml`).
- Job: `schema-gate` — checkout, Node 24, `node
  scripts/schema-gate/schema-gate.mjs`. No `npm ci`: the gate imports only
  node builtins plus the repo's own server modules, so the job runs in
  seconds.
- What blocks: a failing gate fails the check run. **To make it
  merge-blocking, add the `schema-gate` job as a required status check in the
  repo's branch protection for `main`.** That is a repo-settings change —
  needs John's tap (flagged, not done here).

## Extending to other schemas

The harness is bounty-specific today because the incident was. To cover
another schema's convergence path:

1. Add a module entry (import the schema DDL + the class owning `_ensure()`).
2. Add matrix rows that build that schema's legacy states from its DDL.
3. Reuse the oracle-diff + request-path-write pattern in `runRow`.

Keep the oracle approach (diff against a fresh DDL build) rather than
hardcoding expected columns — that is what makes a skipped migration
impossible to miss silently.
