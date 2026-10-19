# Parallel landing (proposal)

Status: proposal for review by the release lane. Nothing here changes
`MERGE-SLOT`, `RELEASE-PAUSE`, branch protection or the release merge gate
until the release lane adopts it in a reviewed migration.

## Problem

Measured 2026-10-19 on the last 28 completed PR runs of `test.yml`:

- PR wall clock p50 22 min, p90 50 min. Jobs mostly run 0.1 to 6 min; they
  wait in the runner queue p90 14 to 22 min.
- One PR push starts about 30 jobs across 9 workflows.
- Landing is one PR at a time: the holder of `MERGE-SLOT` checks the PR,
  merges, posts LAND, releases. Readiness checks (exact head, green checks,
  review) happen inside the slot, so the slot is held for the whole check.
  On 2026-10-19 about 15 LAND-READY PRs waited behind it all day.

## Proposal (option A from the 2026-10-19 room discussion)

Split landing into two phases. Only the second is serialized.

### Phase 1: readiness, in parallel, no slot

Any member may publish a readiness record for a PR. It is the existing
LAND-READY record, checked mechanically instead of by the slot holder:

- `headSha` is the PR's current head;
- `baseSha` is the base the checks ran against;
- every required check run on `headSha` completed with success or an
  intentional skip;
- an independent source review names `headSha` (or an earlier head whose
  later commits the review explicitly covers);
- no open problem key, task hold or `RELEASE-PAUSE` names the PR.

The release merge gate validates the record when it is published and again
in phase 2. A record goes stale when the PR head changes.

### Phase 2: final critical section, under `MERGE-SLOT`

The slot holder takes the oldest valid record and, inside the slot:

1. Re-read `main`. If `main` equals the record's `baseSha`, merge with the
   head SHA pinned.
2. If `main` moved, classify the commits between `baseSha` and `main`:
   - **Disjoint:** none of them touch a file the PR touches, and the PR
     does not touch a shared global file (`package.json`, lockfiles,
     `.github/workflows/**`, `scripts/unit-shards.mjs`, schema or migration
     files). Merge with the head SHA pinned. The full suite on the new main
     commit is the integration check.
   - **Overlapping or global:** do not merge. Mark the record stale with
     reason `base-moved-overlap`; the author rebases, CI reruns, and a new
     record is published.
3. Post the LAND receipt and release the slot.

Target slot hold time: under one minute per PR. The slot auto-expires
after five minutes so a crashed holder cannot stall landing.

### After landing

- `main` runs the full suite on every push, as today.
- Deploys stay gated on a green `main` (deploy-prod already requires it,
  with smoke checks and automatic rollback).
- If `main` goes red after a disjoint merge, landing pauses (existing
  `RELEASE-PAUSE`), the last landed PR is reverted, and its record is
  marked `integration-failed`.

## What changes in code

All in the release lane's merge gate (`scripts/release-merge-gate.mjs`,
currently outside this repository):

- record validation callable without holding `MERGE-SLOT`;
- `grantOf` accepts a validated record plus the disjoint-base check instead
  of requiring the base to equal `main`;
- `guardedMerge` keeps rejecting a second concurrent merge, so the slot
  still serializes the merge call itself;
- slot lease of five minutes.

Required tests: stale head, stale base with overlapping files, stale base
with disjoint files, global-file PR on a moved base, two records racing for
the slot, slot expiry, red main after a disjoint merge.

## Not proposed

- Concurrent merges without the slot (option C in the discussion). It moves
  every integration failure onto `main` and needs deploy-freeze and culprit
  isolation tooling first.
- Retiring `MERGE-SLOT`, changing branch protection, or reinstalling the old
  protection installer.
