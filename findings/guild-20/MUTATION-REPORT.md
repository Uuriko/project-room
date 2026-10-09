# Mutation track report — lock/fence/concurrency paths

**Date:** 2026-10-09 · **Branch:** wave1000/guild-20 · **Runner:** `race-hunt/mutations.mjs`
**Method:** exact-string mutant applied to the working tree, killing test executed, file restored
and verified byte-identical after each mutant. No mutant was committed.

## Results: 9 killed / 1 survived (10 total)

| Mutant | Target | Mutation | Killing test | Verdict |
|---|---|---|---|---|
| M-01 | server/instance-lock.mjs | stale-reclaim `unlinkSync` removed | tests/instance-lock.test.js | KILLED |
| M-02 | server/instance-lock.mjs | `pidAlive` always true | tests/instance-lock.test.js | KILLED |
| M-03 | server/public-work-claim-fence.mjs | trigger `IS NOT 1` → `IS 1` | rh03 | KILLED |
| M-04 | server/public-work-claim-fence.mjs | permit never closed in `finally` | rh03 | KILLED |
| M-05 | server/writer-fence.mjs | writer fn returns version-1 | rh18 | KILLED |
| M-06 | server/work-claims.mjs | E5 round check removed | rh06 | KILLED |
| M-07 | server/channel-journal.mjs | `ON CONFLICT DO NOTHING` removed | rh09 | KILLED |
| M-08 | server/claim-pr-sync.mjs | `!pull.outcome` match widened | rh08 | SURVIVED (benign) |
| M-09 | server/store.mjs | `BEGIN IMMEDIATE` → `BEGIN` | m09-counter-race | KILLED |
| M-10 | server/wake-queue.mjs | lease `state='pending'` check removed | rh11 | KILLED |

## Notable kills

- **M-06** proves the E5 compare-and-release is load-bearing: without it, 40/40 stale token replays
  were accepted (vs 1000/1000 refused with the guard).
- **M-09** proves `BEGIN IMMEDIATE` is load-bearing: with deferred `BEGIN`, the two-process counter
  race lost updates / hit writer errors; with IMMEDIATE the count is exactly 100/100. This is the
  mechanism that closes every cross-process read-modify-write race in the store layer.
- **M-10** proves the wake lease's `state='pending'` predicate is the whole race guard: without it,
  40/40 rounds double-leased.
- **M-05** confirms the writer fence is fail-closed under version skew: a writer registering the
  wrong version gets every write aborted, and unregistered connections get `no such function`.

## Survived: M-08 (assessed benign)

Widening `commitPullRequestLookup`'s link match to include already-settled links does not produce a
wrong settle: `settlePullRequest` still refuses non-live claims (`LIVE_CLAIM_STATES`), and the
first settle terminalizes (`done`) or releases the claim, so a repeated observation is a no-op.
The `!pull.outcome` predicate is defense-in-depth / retry-safety documentation, not a load-bearing
guard. No action needed.

## Gaps noted

Every lock/fence mutant was killed by *existing* tests (instance-lock, public-work-claim-fence)
or by this guild's race scripts. No mutant exposed a test gap requiring a new committed test —
except the two confirmed races (RACE-instance-lock-double-hold.md), whose repro scripts
(rh01, rh02) are the fail-first regressions awaiting the fix.
