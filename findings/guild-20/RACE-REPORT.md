# Race-hunt summary — 20 units

**Date:** 2026-10-09 · **Branch:** wave1000/guild-20 · **Scripts:** `race-hunt/rh*.mjs`
Each unit is a bounded one-shot with a clear done condition. Cross-process units use real
`node:sqlite` files in WAL mode; `TMPDIR` is worktree-local for every run.

## Confirmed races (2 → BUG CONFIRMED)

| Unit | Target | Result |
|---|---|---|
| RH-01 | instance-lock double-boot (empty-file window) | **RACE CONFIRMED** — deterministic double-hold |
| RH-02 | instance-lock stale-reclaim race (200 rounds) | **RACE CONFIRMED** — 188/200 double-holds |
| RH-07 | sweep settles live new round on stale pre-txn GitHub observation | **RACE CONFIRMED** (cross-slice → guild 01) |

Details: `RACE-instance-lock-double-hold.md`, `RACE-sweep-stale-settle-CROSS-SLICE.md`.

## Passed (15)

| Unit | Target | What was proven |
|---|---|---|
| RH-03 | public-work-claim-fence permit discipline | nesting refused, throw resets permit, triggers enforce |
| RH-04 | public fence cross-process (2×60 entries) | serialized, permit closed at rest, 0 gate violations |
| RH-05 | concurrent claim acquisition (2 procs × 100) | exactly one winner per round |
| RH-06 | stale appendWorkPullRequest replay (1000 rounds) | 1000/1000 refused with 409 |
| RH-08 | settle on terminal claim | settle-proof via LIVE_CLAIM_STATES |
| RH-09 | channel-journal concurrent record | idempotent, no duplicates |
| RH-10 | journal imported-vs-failed race | every row ends consistent |
| RH-11 | wake-queue lease race (150 rounds) | exactly one lease winner per wake (after harness fix: pause table) |
| RH-12 | invitation-journal append race (60 rounds) | exactly one winner per sequence |
| RH-13 | merge-slot queue (in-process) | sync critical sections, adopt stickiness, 20k-op invariants |
| RH-14 | claim-reputation concurrent sync | idempotent convergence |
| RH-15 | escrow settle structure | fresh re-read in txn + state machine rejects re-settle |
| RH-16 | fee-credit double-apply (50k) | all refused synchronously |
| RH-17 | identity-mint structure | check-then-insert in one sync txn, no awaits |
| RH-18 | writer-fence hammer (2×200) | 200 registered writes land, 0 unregistered slip through |
| RH-19 | sla-clocks determinism (5k states) | byte-identical outputs |
| RH-20 | graph-reply-journal purity (10k) | no shared-state mutation, clone isolation |

(20 units: 3 confirmed-race + 17 pass; RH-01/RH-02 are the two interleavings of one bug.)

## Mechanism notes

- `BEGIN IMMEDIATE` is the single load-bearing primitive for every cross-process
  read-modify-write (proven by M-09: deferred BEGIN loses updates).
- Single conditional `UPDATE ... WHERE state=...` is the atomic-lease pattern (wake queue,
  channel journal); removing the predicate breaks it (proven by M-10: 40/40 double-leases).
- `ON CONFLICT DO NOTHING` / PKs are the journal idempotency mechanism (proven by M-07).
- The E5 compare-and-release tokens are load-bearing (proven by M-06: 40/40 stale accepted
  without them).
