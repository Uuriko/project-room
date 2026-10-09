# PARTITION PLANNER

Static work partitioning for parallel agent waves. Industrializes the WAVE-500
coordination-overhead finding: **static partitioning produced zero
conflicts/duplicates across 40 tasks; unpartitioned work produced duplicate
byte-identical fixes.** Feed it a task list; get conflict-free lane
assignments with per-partition claim-id namespaces.

Tool: `scripts/partition-plan.mjs`
Validation: `scripts/partition-check.mjs` (worker 10/17 — independent pre-wave overlap gate)
Tests: `scripts/partition-plan.test.mjs` (`node scripts/partition-plan.test.mjs`)

## Usage

```sh
node scripts/partition-plan.mjs --tasks tasks.json --partitions 10 [--prefix waveX]
node scripts/partition-plan.mjs --demo wave300 --partitions 10
node scripts/partition-plan.mjs --tasks tasks.json -k 10 --out plan.json --json
```

Exit codes: **0** clean plan · **1** plan with overlap violations or residual
imbalance (coordinator attention — the plan is still emitted and readable) ·
**2** usage or input error.

## Input format

A bare JSON array, or `{"tasks": [...], "claimPrefix": "..."}`.
Each task: `{id, files[], dirs[], claimPrefix}` — extra fields (e.g. `lane`)
pass through untouched.

```json
[
  { "id": "bp-admission", "files": ["server/admission.mjs", "tests/admission.test.js"], "dirs": [] },
  { "id": "reaper-sweep", "files": ["server/reaper.mjs"], "dirs": [] }
]
```

Paths are repo-relative. A task with an empty footprint (coordination /
research work) conflicts with nothing and absorbs into whichever partition
needs the task count.

## Algorithm

**Phase 1 — conflict graph + greedy coloring.**
Nodes are tasks; an edge joins two tasks whose file/dir footprints overlap:
same file, or a directory containing the other's path (segment-aware —
`server/claims` owns `server/claims/board.mjs` but NOT `server/claimsmore.mjs`).
Greedy largest-degree-first coloring gives internally conflict-free color
classes, which become **execution waves**: a lane runs each wave in parallel
and sequences across waves.

**Phase 2 — balanced bin-packing with must-link closure.**
This is the part a naive coloring gets wrong. Property (a) — no file/dir in
two partitions — *forces* conflicting tasks to be **co-located** in one
partition; coloring alone would separate them and violate (a). So the
indivisible atoms are the conflict graph's **connected components**
(the must-link closure over the color classes). Components are packed into
exactly K bins, largest-first into the smallest bin, then local improvement
(move one atom from a max bin to a min bin while the max-min spread strictly
shrinks) until sizes differ by ≤ 1.

**Guarantees (verified, not trusted):**
- (a) Cross-partition non-overlap holds **by construction** — conflicting
  tasks are never separated — and a final independent pass recomputes it from
  the emitted bins.
- (b) Balance is **best-effort and honestly reported**: an indivisible
  component larger than ceil(N/K) makes ±1 impossible; the residual imbalance
  is printed and exits 1, not hidden.
- (c) Deterministic: identical input always yields the identical plan
  (byte-identical output, covered by test).

Conflicts *inside* a partition (same file touched by two of its tasks) are
reported as **internal conflicts** — the lane serializes those tasks
(single-file lanes: sequence, don't parallelize).

## Output

Human-readable plan to stdout (partitions, task lists, footprints, waves,
verification block) plus machine JSON with `--out`:

```json
{
  "tool": "partition-plan", "version": 1,
  "partitions": [
    {
      "index": 0,
      "claimNamespace": "wave300-p0",
      "taskIds": ["bp-admission", "dp-fastpath-index", "reaper-docs", "shard-migrate"],
      "waves": [["bp-admission", "dp-fastpath-index", "reaper-docs", "shard-migrate"]],
      "tasks": [{"id": "bp-admission", "lane": "backpressure", "files": [...], "dirs": [...]}]
    }
  ],
  "verification": {
    "crossPartitionOverlaps": [], "internalConflicts": [],
    "sizes": [4,4,4,4,4,4,4,4,4,4], "balanced": true,
    "namespacesUnique": true, "mergedAtoms": [...], "overlapAllowed": false
  }
}
```

**Claim-id namespaces**: each partition is assigned `claimPrefix + "-p" +
index` (e.g. `wave300-p0` … `wave300-p9`). Lanes claim work only inside their
partition's namespace, so registry collisions across lanes are impossible by
construction. `--prefix` overrides the default prefix resolution
(explicit flag → input `claimPrefix` → first task's → `"plan"`).

## The K > components case

When the tasks deconflict into fewer independent groups than requested
partitions, splitting a group would put shared files in two partitions —
the tool **refuses** (exit 2) unless `--allow-overlap` explicitly opts in.
With `--allow-overlap`, groups are halved to fill K bins, the resulting
cross-partition violations are listed in the plan, and the exit is 1.
Use fewer partitions, or redesign the work to reduce sharing.

## WAVE-300 demo

`--demo wave300` models the WAVE-300 ten-lane split (data-plane, reaper,
backpressure, fan-out, shards, payloads, replay, stranger-qa, burn-down,
telemetry) as 40 tasks with disjoint file footprints: 40 → 10 partitions,
4 tasks each, zero cross-partition overlap, balanced ±0, exit 0.

Validate the output through worker 10's checker (note its different input
shape — adapt with the command below; axis (a) file/dir and axis (c)
claim-namespace are what the planner guarantees):

```sh
node scripts/partition-plan.mjs --demo wave300 --partitions 10 \
  --out docs/partition-validation/wave300-10lanes-plan.json
node -e '
const fs = require("node:fs");
const plan = JSON.parse(fs.readFileSync("docs/partition-validation/wave300-10lanes-plan.json", "utf8"));
const input = { partitions: plan.partitions.map((p) => ({
  name: p.claimNamespace, worktree: "", branches: [],
  claimIds: [p.claimNamespace],
  dirs: [...new Set(p.tasks.flatMap((t) => t.dirs || []))],
  files: [...new Set(p.tasks.flatMap((t) => t.files || []))],
}))};
fs.writeFileSync("docs/partition-validation/wave300-10lanes-check-input.json", JSON.stringify(input, null, 2) + "\n");
'
node scripts/partition-check.mjs docs/partition-validation/wave300-10lanes-check-input.json
# PASS — 10 partitions, zero overlaps
```

Saved artifacts: `docs/partition-validation/wave300-10lanes-plan.json`
(planner machine JSON), `wave300-10lanes-check-input.json` (checker input),
`wave300-10lanes.check.txt` (checker report: PASS).

## Limitations — read before trusting

1. **Semantic overlap without file overlap sails through.** Two lanes
   changing the same API contract from different files (caller vs callee),
   a schema plus its migrations, or copy text plus the code it describes
   produce zero file edges. The planner guarantees *file-level* separation
   only. Static partitioning is a floor, not a ceiling: pair it with
   contract-level review for cross-cutting changes.
2. **A plan is only as good as the declared footprints.** Undeclared files
   (edits outside the claimed `files[]`/`dirs[]`) void the guarantee. Enforce
   claimed-footprint discipline on the lanes, or verify post-run with
   `scripts/partition-check.mjs` against actual diffs.
3. **Giant components shrink effective parallelism.** When most tasks touch
   shared files (e.g. every WAVE-300 lane touching `docs/openapi.yaml`),
   they collapse into one component and must ride one partition. The tool
   refuses to fake parallelism — redesign the work (shrink shared files,
   extract per-lane modules) to recover it.
4. **Greedy coloring is not optimal.** The color count (and hence wave
   count) can exceed the true chromatic number; waves may be more numerous
   than strictly necessary. Correctness never depends on optimality.
5. **Balance is best-effort.** Oversized indivisible components produce
   honestly-reported imbalance (exit 1). Rebalance by splitting the
   component's work into smaller declared footprints.
