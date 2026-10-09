# PARTITION-CHECK — pre-wave overlap gate

`scripts/partition-check.mjs` is the verifier for the wave partition planner
(worker 9's `scripts/partition-plan.mjs`). Where the planner *guarantees*
disjoint lanes, this script *proves* it: it takes a partition spec and fails
hard if any two partitions collide, so a wave never launches with two lanes
writing the same files, pushing the same branch, claiming the same claim
namespace, or sharing a worktree.

## Input

A JSON file with a `partitions` array. Each entry:

```json
{
  "partitions": [
    {
      "name": "wave500-bughunt",
      "worktree": "/home/hatch/workspace/pr-wave500-bughunt",
      "branches": ["wave500/bughunt"],
      "claimIds": ["wave500-bughunt-01"],
      "dirs": ["tests/bughunt/"],
      "files": ["scripts/bughunt.mjs"]
    }
  ]
}
```

All fields except `name` are optional; a minimum of two partitions is
required. Paths are repo-relative and normalized (trailing slashes,
leading `./`, backslashes are all folded).

## The four checks (pairwise, every partition against every other)

| Axis | Overlap rule |
|---|---|
| (a) file/dir | Two paths collide when equal **or** one contains the other as a directory prefix: dir `server/` overlaps file `server/http.mjs`, and `server/claims/` overlaps `server/` (containment, both directions). |
| (b) branch | Exact branch-name match after trimming. Different lanes must never push the same branch. |
| (c) claim-id | Exact match **or** shared namespace: a trailing worker/index suffix is stripped (`wave500-claim-scale-01` and `wave500-claim-scale-02` share namespace `wave500-claim-scale`), because the claim registry collides on the namespace. Identical ids are reported as such. |
| (d) worktree | Same resolved absolute path, or one nested inside the other (nested worktrees share the git working area). |

## Usage

```sh
# human-readable gate report
node scripts/partition-check.mjs partitions.json

# machine-readable (JSON) for CI plumbing
node scripts/partition-check.mjs --json partitions.json
```

## Exit codes (CI-usable)

| Code | Meaning |
|---|---|
| 0 | PASS — zero overlaps across all partitions |
| 1 | FAIL — one or more overlaps found; each is listed with axis, partition pair and exact conflicting values |
| 2 | usage / input error (missing file, bad JSON, fewer than two named partitions) |

FAIL output names the exact collision, e.g.:

```
FAIL — 5 overlap(s) across 2 partitions:
  [file/dir] overlap-a × overlap-b: "server" ↔ "server/claims"
  [file/dir] overlap-a × overlap-b: "server" ↔ "server/claims/board.mjs"
  [branch] overlap-a × overlap-b: "wave500/coord-cost"
  [claim-id] overlap-a × overlap-b: shared namespace "wave500-coord-cost" ("wave500-coord-cost-02" ↔ "wave500-coord-cost-03")
  [worktree] overlap-a × overlap-b: "/home/hatch/workspace/pr-wave500-coord-cost" ↔ "/home/hatch/workspace/pr-wave500-coord-cost"
```

## As a pre-wave gate

1. Worker 9's planner emits the partition spec for the wave.
2. Run `node scripts/partition-check.mjs spec.json` — gate is GREEN only on exit 0.
3. On exit 1, re-partition (split the overlapping scope or reassign the lane)
   and re-run. A wave launches only after PASS.

## Tests

```sh
node scripts/partition-check.test.mjs   # node:test; TMPDIR worktree-local recommended
```

Fixtures live in `scripts/partition-check.fixtures.mjs`:

- `allWaves` — PASS fixture: the 21 real WAVE-300/400/500 worktree + branch
  names, verified live 2026-10-08 (worktrees cleaned up after their waves;
  the three still present re-verify identical). Scopes are topic-derived and
  disjoint by construction.
- `overlapPair` — FAIL fixture: a deliberately colliding pair built to trip
  **all four axes at once** (dir-prefix containment, shared branch, shared
  claim namespace, shared worktree). Used by the test suite to prove each axis
  fires.

## Scope limits

- Branch check is exact-match only: it will not catch two lanes pushing
  *different* branches that touch the same files — that is what the file/dir
  check is for.
- Claim-namespace stripping is heuristic (`-NN`, `/wN` suffixes); ids that
  don't follow the convention are compared exactly.
- The script does not validate that listed paths exist — it checks for
  collisions between the lanes' declared scopes, which is what a gate needs.
