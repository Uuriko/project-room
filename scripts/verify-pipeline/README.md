# verify-pipeline — scratch-trunk verification pipeline (W2 prototype)

Verifies candidate fixes in isolated scratch worktrees **before they land**.
Semantic collisions (two fixes, same behavior) are resolved by running both
in scratch; **winner = green + smaller diff**.

## Layout

- `cone.sh` — affected-test cone: given `base..head`, maps changed files to
  the minimal test set.
  - Rule A: `tests/**` files touched by the diff are always in.
  - Rule B: tests whose import/from/require strings reference the changed
    module's full path (`server/work-claim-routes`, not the bare stem —
    a bare stem like `index` matches every `index.mjs` in the repo).
  - Rule C: stem-named test files (`tests/work-claim-routes*.test.*`).
  - Changed files with no test reference are reported as coverage gaps.
- `cone-run.sh` — runs the cone (one `node --test` process per file,
  parallel via `xargs -P $CONE_JOBS`) and emits a JSON verdict.
- `verify-pipeline.sh` — the pipeline: `verify` / `collide` / `cone`.

## Usage

```bash
export REPO=/path/to/project-room            # source repo (never modified)
export VERIFY_SCRATCH=/path/to/scratch       # worktrees + verdicts land here

# verify one candidate end to end
./verify-pipeline.sh verify <base> <head> <candidate-id>

# resolve a semantic collision between two candidates
./verify-pipeline.sh collide <base> <refA> <refB>

# debug aid: print the cone for a diff
./verify-pipeline.sh cone <worktree> <base> <head>
```

## Stages

1. **ingest** — resolve refs, record diffstat (60s timeout). Empty diff → reject.
2. **scratch worktree** — `git worktree add --detach` per candidate; deps via
   `node_modules` symlink (`VERIFY_NPM_CI=1` for exact `npm ci`). Main is never
   touched; nothing is committed to the source repo.
3. **affected-test cone** — `cone.sh` (180s timeout). Empty cone **fails closed**
   (`no-coverage` verdict, routed to triage) — green-by-default on zero tests
   is how regressions slip through.
4. **run cone** — `cone-run.sh` with `TMPDIR` pointed inside the worktree
   (repo convention; `/tmp` is a 512MB tmpfs shared by all agents).
5. **collision detect** (collide mode) — candidates collide when their changed
   files intersect OR their cones intersect. Disjoint → verify independently.
6. **score** — rank: `pass` 0, `pass-with-flakes` / `pass-with-baseline-failures`
   1, `no-coverage` 2, `fail` 3, `timeout` 4; tie-break: smaller diff wins.
7. **verdict** — JSON on stdout; non-zero exit unless landable.

## Failure modes

| mode | handling |
|---|---|
| cone fails | **adjudicate**: 1 rerun of the failed files at head + 2 runs at base in a second worktree. Head-flaky (rerun passes) → `pass-with-flakes`. Consistent at head but fails ≥1 at base → `pass-with-baseline-failures` (pre-existing, landable). Consistent at head + clean at base 2/2 → red. Single samples are not trusted — the board test failed at base in 2 of 3 observations (flaky), which misfires naive base-vs-head comparison. |
| cone timeout (per-file `CONE_FILE_TIMEOUT`, default 600s) | `timeout` verdict, rank 4 |
| empty cone | `no-coverage` — fail closed, human triage |
| infra failure (bad ref, worktree add fails, npm ci fails) | exit 2 — retry the pipeline, don't blame the candidate |
| both candidates red in a collision | no winner; verdict `both-red` |

## Timeouts

ingest 60s · worktree 300s · cone map 180s · cone run 1200s ·
per-candidate wall 1800s. Env overrides: `CONE_JOBS`, `CONE_FILE_TIMEOUT`,
`VERIFY_NPM_CI`, `VERIFY_BASELINE=0` (skip baseline compare),
`VERIFY_SCRATCH`, `REPO`.

## Measured (2026-10-07, uuriko/project-room, 2-core VM)

| candidate | cone files | cone time | full suite | speedup |
|---|---|---|---|---|
| PR #1594 (work-claim routes) | 18 | 5.7 min | 46.1 min (6464 tests) | ~8× |
| PR #1533 (mcp-http) | 12 | 3.7 min | 46.1 min | ~12× |
| PR #1546 (evals harness) | 2 | 6.7 s | 46.1 min | ~410× |

Failure agreement: the one cone failure observed (board-list test in
`work-claim-integrity.test.js`) also fails in the full suite and at both
candidates' merge bases — pre-existing, caught identically. No full-suite
failure inside any cone's file set was missed by the cone.

Collision demo: PR #1594 vs PR #1595 (two independent implementations of the
same work-claim board change, overlapping `server/work-claim-routes.mjs`) —
collision detected via intersecting changed files; #1595 green + 133-line diff
beats #1594 red + 192-line diff. Winner: #1595's approach.
