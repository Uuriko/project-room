# WAVE-400 Coordinator 6/8 — Performance profiling + hot-path optimization

## Worker contract (read all of this before touching code)

You are a ONE-SHOT worker. Your tree: `~/workspace/pr-wave400-perf/`
(branch `wave400/perf`, already checked out).

**First command, every time:**
```
cd ~/workspace/pr-wave400-perf && git branch --show-current
```
Must print `wave400/perf`. If not, STOP and report.

### Method — mandatory, no exceptions
1. **BENCHMARK BEFORE.** Write a bench under `perf/wave400-<slug>.mjs` driving a REAL
   `RoomStore` (see `perf/local-server.mjs` and existing tests for construction) at
   realistic volumes (hundreds of claims, thousands of events). Record numbers.
2. **PROFILE.** `node --cpu-prof` or targeted timers. Name the single top cost.
3. **Change ONE thing.**
4. **BENCHMARK AFTER** with the identical script. Keep ONLY measured wins.
5. **Run affected tests** with worktree-local TMPDIR. Zero regressions required.

A clean "measured, no win, committed nothing" report is a GOOD result.
Never ship "should be faster" without numbers.

### Branching / commits
- Create YOUR branch from `wave400/perf`: `git checkout -b wave400/perf-<slug>`
- Commit there, push to origin. NEVER touch main. Coordinator merges one at a time.
- Worktree-local TMPDIR for everything: `TMPDIR=~/workspace/pr-wave400-perf/.tmp`
  (never `/tmp` — 512MB tmpfs, gets reaped, fills up and fakes SQLITE_FULL failures).
- Never `git stash` in a shared tree. Commit instead.

### Constraints
- Backward compatible: no wire breaks, no removed params, no new required fields,
  no behavior change except speed.
- **Do NOT redo WAVE-300's lanes.** Read
  `~/workspace/pr-wave300-fanout/docs/WAVE300-FANOUT-DESIGN.md` (read-only reference)
  before optimizing near the SSE pump, wake drain, or board cursor. Their territory:
  shared SSE pump (F1), wake-dispatch concurrency + coalescing (F2), delta board
  cursor (F3), projection-cache invalidation (F4), `?fast=1` claim paths
  (`~/workspace/pr-wave300-data-plane`, branch `wave300/data-plane-fastpath`),
  lease-sweep-on-read removal (reaper lane — measure only, coordinate, yield).
- Measured perf changes only. No reformatting or restructuring for style.
- Docs: update the doc comment / docs page for anything you change.
- No spending, no sends, no credentials, no external network in benches/tests.
- Delete what the change orphans. Done-checklist per change: say what you deleted,
  say what you didn't check.

### Report back
Before/after numbers (bench script path), profiled top cost, what changed,
tests run + result, your branch name + head SHA, what you deleted,
what you didn't check. If no measured win: report it and commit nothing.

### Overlap check
Before your first edit, run `gh pr list --repo Uuriko/project-room --state open
--search "<your target area>"` and skim for an open PR touching the same
function. If one exists, read its diff; if your change would collide, report
and yield rather than duplicating.
