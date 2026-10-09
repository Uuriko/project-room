# Concurrency model — Project Room server

**Scope:** what the locks protect, and the single rule everything else follows.
**Verified:** 2026-10-09 by wave1000 guild-20 (50-unit concurrency burn).

## The one rule

**SQLite is the only cross-request mutex.** Node is single-threaded, so within one process a
synchronous critical section cannot interleave. Across processes (or across the event loop at an
`await`), only the database serializes. Every race-sensitive path in `server/` reduces to one of:

1. A single conditional SQL statement (atomic by construction), or
2. A read-modify-write inside one `BEGIN IMMEDIATE` transaction, or
3. A compare-and-release token (`expectedClaimedAt`/`expectedHistoryLength`), or
4. **A bug** — see `RACE-instance-lock-double-hold.md` and `RACE-sweep-stale-settle-CROSS-SLICE.md`.

## Lock inventory

| Lock | Lives in | Protects | Mechanism |
|---|---|---|---|
| DB write lock | `server/store.mjs` `nodeStorage.transaction` | every read-modify-write in the store | `BEGIN IMMEDIATE` + `busy_timeout=3000`, WAL mode |
| Instance boot lock | `server/instance-lock.mjs` | one `server.mjs` per database file (growth snapshot is a plain JSON file; SQLite alone can't guard it) | exclusive-create file + PID-liveness reclaim — **racy, see findings** |
| Public claim writer permit | `server/public-work-claim-fence.mjs` | `work_claims`/`work_claim_config` rows in public namespaces | singleton `enabled` row flipped 0→1→0 inside the store transaction + BEFORE triggers that `RAISE(ABORT)` |
| Writer fence | `server/writer-fence.mjs` | every fenced table against unknown writers | BEFORE INSERT/UPDATE/DELETE triggers calling per-connection `project_room_writer_v38()`; unregistered connection → write refused |
| Wake lease | `server/wake-queue.mjs` `lease()` | one worker per wake attempt | single conditional `UPDATE ... WHERE state='pending'` — atomic |
| Merge slot | `server/merge-queue.mjs` | one lane per merge slot | **in-process only** (`createMergeSlotQueue` closure state); no cross-process protection by design (phase 1) |
| Claim round token | `server/work-claims.mjs` `appendWorkPullRequest`, update route | PR-link appends / updates against stale reads | `expectedClaimedAt` + `expectedHistoryLength` compare-and-release → 409 `work_claim_conflict` |
| Escrow finality | `server/bounty-escrow.mjs` `_requireFinalityMove` | double-settle / double-payout | state-machine guard (`payout` requires `approved`) + fresh row re-read inside the store transaction |
| Journal idempotency | `server/channel-journal.mjs` etc. | duplicate delivery / duplicate append | PK / `ON CONFLICT DO NOTHING` / append-only triggers |
| Identity mint | `server/agent-identities.mjs` | duplicate mint, pilot-limit overrun | whole check-then-insert inside one store transaction |

## What is deliberately NOT locked

- **Reads**: `readTransaction` uses deferred `BEGIN` — a consistent snapshot, never a lock. Long
  audits (`auditRecovery`, reputation sync) never block writers.
- **The sweep's GitHub fetch**: `collectPullRequestLookups` runs *before* the write transaction so
  network I/O never holds the write lock. The price is the stale-observation race (filed cross-slice).
- **Pure state machines** (`work-claims.mjs`, `claim-coordination.mjs`, `graph-reply-journal.mjs`,
  `sla-clocks.mjs`, `fee-credit-ledger.mjs`): no shared mutable state; race-safety comes from the
  caller holding the transaction, not from the functions themselves.

## The transaction nesting rule

`store.transaction` **re-enters**: a nested call inside an active transaction just runs `fn()`
(no savepoint on the non-isolated path). Consequence: helpers like `withPublicWorkClaimWriter`
compose safely, and the permit's "must be closed before entry" check is what refuses *logical*
re-entry, not the transaction machinery. The `isolated: true` path uses `SAVEPOINT
room_isolated_write` for best-effort writers that may fail without taking the parent down.
