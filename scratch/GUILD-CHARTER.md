# GUILD-CHARTER — COORD-300 GUILD-05 (collision avoidance)

> Coordinator: COORD-300 guild-05 (recovery respawn) · depth 2/2 ·
> branch `coord300/guild-05` · worktree `~/workspace/pr-coord300-guild-05/`
> Charter written: 2026-10-09 ~12:45 PDT (file-based; see § Comms)
> Supersedes: the original guild-05 coordinator (spawned 11:09 PDT, died in
> the 12:12 PDT daemon restart before creating a branch, worktree, or any
> room post — verified: no `coord300/guild-05` ref on origin, no worktree).
> No partial work existed to resume; this charter starts clean.

## Mission (redirected)

**Original mission** (launcher brief): build collision-avoidance tooling —
first-claim-wins helpers, partition planners, file-lock registries,
pre-spawn checkers, watchdogs — with 50 workers.

**Redirect** (Dot / Jill-Dot, John's orchestration authority, room seq 8263,
received 12:23 PDT): re-aim from "build new" to **"repair observed
coordination failures"**. New mission, overriding:

> Normalize ancestor/descendant path overlaps and propose partitions.
> Acceptance fixtures: replay18/28 (replay-scenarios/skill-harness vs
> agent-conversations overlap), docs10/33 (docs partitions), broad server
> lease vs PR #2272. Report-only — NEVER steal or expire a live claim;
> never touch live permissions.

**Redirect constraints (Dot):** additive + offline/fixture-backed only; do
NOT alter live permissions; do NOT launch additional workers (original
50-worker plan cancelled); do NOT replace the current board/protocol; no new
parallel queue.

## What this guild builds (additive, branch-only)

1. `scripts/collision-path-normalize.mjs` — canonicalize claim path-scopes;
   classify every pair as disjoint/identical/contains/partial with evidence.
2. `scripts/collision-partition-propose.mjs` — deterministic static
   partition planner (N agents → N disjoint slices, machine-verified).
3. `scripts/collision-check.mjs` — pre-dispatch gate (exit 0/2/1).
4. `tests/collision-path-overlap.test.js` + `tests/fixtures/collision/` —
   the three acceptance fixtures + negative controls.
5. `docs/COLLISION-PATH-OVERLAP.md` — design, measurements, integration
   dependencies, explicit "what is NOT proven".

## Deliverable (per Dot)

Exact SHA of branch head, a runnable test, a negative control, integration
dependencies, and a "what is NOT proven" section. One coordinator rollup at
the end (this guild's final report).

## Comms

ROOM POSTS: file-based for this guild. Depth-2 coordinators hold no room
posting identity (the live room events API returns 401 `unauthenticated`
without an enrolled agent identity; minting one would violate the
no-credentials rule) — the same basis on which guild-02 went file-based and
the WAVE-2000 launcher skipped per-guild room posts wave-wide. Charter and
rollup texts live in this branch (`scratch/GUILD-CHARTER.md`,
`scratch/DONE-ROLLUP.md`); the parent orchestrator may relay them to the
room if it holds a posting identity. No prior guild-05 GUILD-CHARTER exists
to avoid duplicating (verified via origin ref absence + ledger).

## Hard rules

Never push to main · never open PRs · never write to production · never
deploy · never spend · read-only vs live systems · report-only: propose
partitions, never seize or expire claims. Dot's room direction governs.
