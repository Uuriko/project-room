# writer-fence gotchas (`server/writer-fence.mjs`)

## 1. The fence is per-connection — every new connection must `registerWriter`

The triggers call `project_room_writer_v38()` as a SQL function. `registerWriter(db)` installs it
on **one** `DatabaseSync` handle. Any code path that opens its own connection (tests, scripts,
backup tools, a second process) and writes to a fenced table without registering gets
`no such function: project_room_writer_v38` — a refusal, but a confusing one. If you see that
error, the fix is `registerWriter`, not the fence.

## 2. Version skew fails closed (verified)

`registerWriter` installs `project_room_writer_v6` … `v38`. A writer built against an older
`STORE_SCHEMA_VERSION` registers a function returning the wrong number → every write aborts
with `unsupported database writer`. Mutation M-05 proved it. Rolling upgrades must keep the
writer version in lockstep with the schema version — there is no "compatible range".

## 3. `installWriterFence` requires the migration transaction

It throws unless `db.isTransaction`. Never call it ad-hoc on a live connection; a half-installed
fence (some triggers present, some missing) makes `verifyWriterFence` throw
`Database writer fence requires operator reconciliation` on every open.

## 4. The exact-table-list gate is the sharp edge

`auditRecovery()` (via `applicationTables`) requires every table on disk to be registered in
`unfencedAdditiveTables`, `rebuiltAdditiveTables`, `deployedV28Tables`, or the fenced set.
**Every new additive table a slice creates must be registered** or recovery throws. This is the
most common fence-adjacent failure for feature work — not the triggers themselves.

## 5. `verifyWriterFence` reads `sqlite_master` — no torn reads, but no snapshot either

It runs inside the caller's transaction (audit → `readTransaction`, so snapshot-consistent).
Called standalone outside a transaction, concurrent DDL could in principle show a partial
trigger set — but the failure direction is always "throw and demand reconciliation", never
"silently pass". Fail-closed by construction.

## 6. Trigger SQL is compared verbatim

`verifyWriterFence` compares trigger `sql` strings exactly (after whitespace normalization).
Reformatting a trigger definition — even semantically identical — trips the fence. Change the
definition in `fenceDefinitions`, never by hand in the database.
