# Fence semantics

Two fences, two different jobs. Both fail closed.

## 1. Writer fence (`server/writer-fence.mjs`) — "which code may write"

- Every fenced table gets three triggers (`writer_v38_<table>_{insert,update,delete}`) that call the
  SQL function `project_room_writer_v38()` and `RAISE(ABORT, 'unsupported database writer')` unless
  it returns exactly `38` (`STORE_SCHEMA_VERSION`).
- The function is registered **per connection** by `registerWriter(db)`. A connection that never
  registered gets `no such function` — also a refusal. There is no "allow" path that isn't explicit.
- Mutation M-05 verified: a writer registering version-1 has every write aborted; hammering 200
  concurrent writes from a registered and an unregistered connection, exactly the 200 registered
  writes land, 0 unregistered writes slip through (`race-hunt/rh18-writer-fence-hammer.mjs`).
- `verifyWriterFence(db)` compares every `writer_v*` trigger's SQL against the expected definitions
  and requires each present fenced table to carry its exact trigger. `installWriterFence` refuses
  to run outside the migration transaction (`db.isTransaction`).
- Additive tables must be registered in `unfencedAdditiveTables` (or the fenced list) or
  `auditRecovery()` throws `Recovery data requires operator reconciliation` — the exact-table-list
  gate is the integrity check, not the fence itself.

## 2. Public work-claim fence (`server/public-work-claim-fence.mjs`) — "when may public claims be written"

- A singleton permit row (`public_work_claim_writer_permit`, `enabled` 0/1, closed at rest).
- `withPublicWorkClaimWriter(store, fn)`:
  1. Inside the store transaction, asserts the permit is 0 ("must be closed before entry"),
     then sets it to 1.
  2. Runs `fn()` — must be synchronous (async fn is refused: "Public claim transactions must
     remain synchronous").
  3. `finally`: sets the permit back to 0 — guarded by `store.db.isTransaction`, because an I/O
     failure may already have rolled the transaction back (a second write would mask the real error).
- BEFORE triggers on `work_claims`/`work_claim_config` (INSERT/UPDATE/DELETE) abort with
  `'unsupported public claim writer'` when the touched row is in a public namespace
  (`EXISTS (SELECT 1 FROM public_work_tasks WHERE namespace_key = NEW.room_id)`) and the permit
  is not open.
- Verified by `race-hunt/rh03` (nesting refused, throw resets permit, trigger blocks unpermitted
  protected writes, allows permitted ones) and `race-hunt/rh04` (two processes × 60 entries:
  serialized, permit 0 at rest, zero gate violations). Mutation M-03/M-04 (inverted trigger,
  removed finally-close) are both killed.

## Gotchas (see also `*-GOTCHAS.md`)

- The permit is a **row**, not a lock: two processes entering `withPublicWorkClaimWriter`
  concurrently serialize on `BEGIN IMMEDIATE`; the second blocks (busy_timeout) then proceeds.
  There is no queue or fairness — just SQLite's lock.
- `verifyPublicWorkClaimFence` requires the permit **closed at rest** (`enabled=0`); any crash
  between open and close rolls back (the open was inside the transaction), so at-rest-open means
  a bug, not a crash.
- Trigger `WHEN` clauses reference `NEW.room_id`/`OLD.room_id`: the fenced tables must actually
  carry `room_id` or the trigger fails at write time, not at install time.
