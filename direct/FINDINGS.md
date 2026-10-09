# WAVE-2000 Guild 20 — direct findings (coordinator's own work)
Slice: *lock* + *fence* + concurrency paths. All work local; branch wave2000/guild-20.

## Ranked findings

### F-1 (FIXED on this branch): work-claim-sqlite delete()/configure() multi-statement read-modify-writes not wrapped in transaction()
- **File**: `server/work-claim-sqlite.mjs` — `delete()` (dependent-waiving loop + DELETE), `configure()` (read-merge-upsert).
- **Hazard**: two writers on separate connections interleave the read-modify-write → a lost waiver re-strands a dependent claim (dependsOn keeps a deleted id → `readyClaims` never returns it, ownerless/invisible), or a lost config key.
- **Repro**: `direct/stress-registry-configure.mjs` demonstrates both lost updates at the SQL level (2 PASS — hazard proven).
- **Fix**: wrapped both bodies in the registry's `transaction()` (nesting-safe; no-op when the caller already holds the store write tx, e.g. land-queue delete path).
- **Fail-first regression**: `tests/work-claim-sqlite-concurrency.test.js` — 4 tests. Verified red→green: 3 fail on unfixed code (tx-routing ×2, rollback atomicity), 4/4 pass with fix. Existing suites still green: work-claim-sqlite (2/2), work-claim-multiprocess-race (1/1), public-work-claim-fence (4/4), land-queue (21/21).
- **Severity**: low in production (single store + BEGIN IMMEDIATE + instance-lock already serialize; all in-repo callers wrap). Defense-in-depth for direct registry users / future multi-connection callers.
- **Note**: the wave's BUG CONFIRMED room-post budget was not used — per launcher correction, room posts are skipped; findings ride in the rollup.

### F-2 (latent, same class — documented, not changed): noteReadyWork() duplicate ready_work wake across connections
- **File**: `server/work-wants.mjs` — `noteReadyWork()` reads `last_wake_at`, enqueues, then UPDATEs, with no transaction of its own. Two connections can both pass the 10-min window check and enqueue duplicate wakes (messageId embeds `at`, so no dedup).
- **Why not fixed**: the only in-repo caller (`server/work-claim-routes.mjs:727`, inside `commit()`) runs inside the route's `registry.transaction(run)` → atomic in production. Wrapping it independently would be pointless (nesting-safe no-op) and the module documents "called inside the claim transaction".
- **Severity**: latent only; needs 2 store instances (excluded by instance-lock).

### F-3 (latent, same class — documented, not changed): SlaBreachAlertJournal.notify() MAX()+1 id generation
- **File**: `server/sla-breach-journal.mjs:113` — `next = MAX(id)+1`. Safe under the store's BEGIN IMMEDIATE; idempotency properly keyed on UNIQUE(account_id, thread_id, produced_at) with ON CONFLICT DO NOTHING. Latent only under multi-writer.

## Verified sound (stress-tested, no bug)

### V-1: instance-lock.mjs mutual exclusion across processes
- `direct/stress-instance-lock.mjs`: 20-process fresh-acquire race and 20-process stale-reclaim race → hold-interval overlap check proves no two holders at the same instant; lock file valid JSON; SIGKILLed holder leaves reclaimable stale lock; next boot reclaims. All PASS.

### V-2: writer-fence.mjs
- `direct/test-fences.mjs`: stale (unregistered) writer INSERT blocked by trigger; `verifyWriterFence` passes intact and throws on a tampered (dropped) trigger; unfenced additive tables writable by unregistered writer (by design, documented).

### V-3: public-work-claim-fence.mjs
- Direct public-namespace claim write blocked without permit; allowed inside `withPublicWorkClaimWriter`; permit verified closed at rest; open permit fails verification; async fn refused; re-entry with open permit refused. All PASS.

### V-4: spend-grants reaper vs settle serialization
- `direct/stress-spend-reaper.mjs` (two connections, one file): reaper-first → late settle loses (no double-settle), final state voided + room reservation released; settle-first → reaper finds nothing, charge recorded; unexpired reservations never reaped. 7/7 PASS. Residual: a caller slower than the 10-min RESERVE_LEASE_MS can be voided mid-call (by design — lease exceeds every priced call; settle() then returns false and the tool result must be treated as uncharged).

### V-5: inbox send reserve/dispatch
- `server/inbox.mjs` `apply()` wraps the whole flow (including `transitionSend` revision checks) in `store.transaction` (BEGIN IMMEDIATE); `send.dispatch` persists status=unknown before the external call. Sound.

### V-6: guest self-serve LRU eviction
- `server/guest-invites.mjs` redemption path (count check → evict → insert) runs inside `store.transaction` (line 694). Sound.

## Pure modules (no concurrency surface)
`server/ip-blocklist.mjs`, `server/sla-clocks.mjs`, `server/claim-collisions.mjs`, `server/work-claims.mjs` (pure state machine), `server/claim-coordination.mjs` — no I/O, no shared mutable state; nothing to race.

## Lock-order inversions: none found
The slice has exactly one lock: the SQLite write lock taken via BEGIN IMMEDIATE
in `store.transaction` (and the module-local equivalents in spend-grants /
public-work-claim-fence, all nesting-safe via `db.isTransaction`). The
instance-lock file is a boot-time process lock, always acquired before any DB
handle opens — a consistent global order. No second lock exists to invert
against: `withPublicWorkClaimWriter` inside `store.transaction` nests safely,
and `chargeSpendBeforeCall` → `authorizeSpend` → `transact()` nests safely too.
