# BUG (cross-slice → guild 01) — sweep commits a stale pre-transaction GitHub observation onto a new claim round

**File:** `server/claim-pr-sync.mjs` — `commitPullRequestLookup` (called from the sweep route in
`server/work-claim-routes.mjs`)
**Severity:** medium (unjust auto-release/complete of a live claim; needs a narrow interleaving)
**Status:** reproduced deterministically with a stubbed fetch; `race-hunt/rh07-sweep-stale-settle.mjs`
**Slice note:** claim logic belongs to guild 01 — filing with repro, not fixing.

## The race

The sweep deliberately fetches PR state from GitHub *before* opening its write transaction (so the
network round-trip never holds the room write lock). `commitPullRequestLookup` then matches the
fetched result to the current claim row **by URL only** — unlike `appendWorkPullRequest`, it carries
no `expectedClaimedAt`/`expectedHistoryLength` round token.

Failing interleaving (all steps verified in the repro):

1. **T0** — sweep pre-reads claim C (round 1, owner o1, PR U linked, no outcome).
2. **T1** — sweep's GitHub fetch observes PR U = `closed`. (Stale result captured.)
3. **T2** — round 1 lapses (lease expiry → `releaseExpired`); o2 claims C (round 2) and re-links U —
   o2 reopened the PR on GitHub after T1. Re-linking the same PR across rounds is the explicitly
   supported flow (`appendWorkPullRequest`: "re-linking it re-asserts the PR for the current round").
4. **T4** — the sweep transaction commits the T1 `closed` observation: `commitPullRequestLookup`
   finds link U with no outcome on round 2's live row, stamps `outcome=closed, syncedAt=T4`
   (making the stale observation look fresh), `pullsReadyToSettle` → `settlePullRequest` →
   **round 2's live claim is auto-released** (`state=unclaimed, owner=null`).

Repro output: `commit returned settled=true; final state=unclaimed owner=null` —
`RH-07 RESULT: RACE CONFIRMED`.

## Why it's wrong

The observation was true at T1 (round 1) but false at commit time for round 2 (the PR was reopened).
The settle path has no way to distinguish "PR closed during this round" from "PR was closed during
a previous round and has since been reopened". The append path solved the identical problem with
`expectedClaimedAt` compare-and-release (E5/#2088); the sweep settle path was left without a token.

## Narrowness

Requires: a sweep in flight + a claim round turning over mid-sweep + the same PR re-linked in the
new round + a GitHub state flip between fetch and commit. Rare, but the consequence is a live claim
killed by stale data — and the stamped `syncedAt=T4` erases the evidence that the data was stale.

## Companion check (passes)

`race-hunt/rh08-settle-terminal.mjs`: a stale `merged` observation against a *terminal* (done) claim
is correctly refused — `settlePullRequest`'s `LIVE_CLAIM_STATES` guard holds. The hole is
specifically *live new round* vs *stale observation*, not terminal re-settle.

## Repro

```
cd ~/workspace/pr-wave1000-guild-20
REPO=$PWD TMPDIR=$PWD/.tmp node race-hunt/rh07-sweep-stale-settle.mjs
```

## Fix direction (for guild 01)

Carry the round token through the sweep: stamp `claimedAt` (and/or `claimHistoryLength`) onto the
lookup result at pre-read time and re-check it in `commitPullRequestLookup` before applying; on
mismatch, drop the observation (the next sweep re-polls). Alternatively re-fetch on mismatch.
