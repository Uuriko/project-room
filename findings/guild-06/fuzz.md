# Fuzzing — guild-06 (scripts-rest)

Head: `a436d0cac` · 2026-10-09. Method: 15 units, each in a disposable
`origin/main` worktree, 9 hostile probes per script with a 20s per-probe
timeout: no-args, `--help`, unknown flag, bare `--`, nonexistent file arg,
empty-string arg, 100KB arg, NUL-byte arg, 5KB `/dev/urandom` on stdin,
2× concurrent `--help`, and `--help` under `env -i` (bare env).
Assertions: no hangs, no unexpected pass/fail vs the script's contract,
no partial writes (worktree `git status`), no interference between concurrent runs.

## Inputs run

15 scripts × 11 probes = **165 fuzz inputs**. Raw logs:
`findings/guild-06/logs/fuzz-{01..15}.result` (+ per-probe `.out` files).

| unit | script | result |
|---|---|---|
| fuzz-01 | lint.mjs | clean |
| fuzz-02 | flaky-detect.mjs | clean |
| fuzz-03 | check-deps.mjs | clean |
| fuzz-04 | scan-secrets.mjs | clean (lenient argv) |
| fuzz-05 | stamp-version.mjs | clean |
| fuzz-06 | reachability.mjs | slow path, no hang (see §2) |
| fuzz-07 | docs-link-check.mjs | clean (lenient argv) |
| fuzz-08 | routes-inventory.mjs | slow (~20s startup), no hang (see §2) |
| fuzz-09 | openapi-gen.mjs | clean |
| fuzz-10 | perf-budget.mjs | slow by design (browser+server boot) |
| fuzz-11 | check-wiki.mjs | clean (lenient argv) |
| fuzz-12 | secret-scan-check.mjs | slow (full tree scan under load) |
| fuzz-13 | untested-modules-lint.mjs | clean (lenient argv) |
| fuzz-14 | journey-coverage.mjs | clean (lenient argv) |
| fuzz-15 | claims-index.mjs | **BUG: hangs when gh stalls** (see §1) |

## 1. Real bugs (with repro)

### BUG-1: `scripts/claims-index.mjs:71` — unbounded `gh` subprocess hangs forever
`fetchComments()` runs `execFileSync("gh", ["api", ... , "--paginate"])` with
**no `timeout` option**. When `gh` stalls (network blip, auth prompt), the
script never exits — no output, no error, unkillable except by signal.

Repro (deterministic, no network):
```
mkdir -p /tmp/fakebin && printf '#!/bin/sh\nsleep 120\n' > /tmp/fakebin/gh && chmod +x /tmp/fakebin/gh
timeout 15 env PATH="/tmp/fakebin:$PATH" node scripts/claims-index.mjs --format json --out /tmp/out
# exit=124: the script itself never exits; the outer timeout kills it
```
Control: with a failing (non-hanging) `gh`, the script exits 3 with the helpful
"failed to fetch #266 comments via `gh api`… (Or pass --comments <file>.)" message.
Fail-first regression test: `tests/gh-subprocess-timeout.test.js`
("claims-index.mjs exits on its own when gh stalls") — fails pre-fix via
ETIMEDOUT at the 60s bound, passes once the gh call is bounded (<60s; 30s suggested).
Posted to muse-room as BUG CONFIRMED.

### BUG-2: `scripts/merge-queue-dryrun.mjs:33` — same unbounded-`gh` pattern
`ghApi()` wraps `execFileSync("gh", …)` with no timeout; the script calls it at
module top level (line 52), so a stalled `gh` hangs the script before it prints
anything.

Repro: same fake-hanging-`gh`; `timeout 12 env PATH="/tmp/fakebin:$PATH" node
scripts/merge-queue-dryrun.mjs` → exit 124 (hung).
Fail-first test: `tests/gh-subprocess-timeout.test.js` ("merge-queue-dryrun.mjs
exits on its own when gh stalls"). Posted to muse-room as BUG CONFIRMED.

### Same class, not separately verified
- `scripts/merge-queue-eject-budget.mjs:232` (`failingCheckRuns`): `execFileSync("gh", …)`
  without timeout. Best-effort path (returns [] on error), but a stalled gh hangs
  it the same way. Fix with the other two.
- `git`-based `execFileSync` calls across the slice (ci-changes, candidate-runtime-fixture,
  frozen-runtime-fixture, helper-agent-exercise, live-upgrade-draft, fallback-draft)
  are local and fast — no hang risk; left alone.

## 2. Slow-but-not-hung (observations, not bugs)

Several "HANG" probe verdicts were the 20s probe timeout firing under parallel
load (8 concurrent units), not true hangs. Solo re-runs complete:

- `routes-inventory.mjs`: ~20s wall for ANY invocation (import stall ~9s —
  `route-docs-check.mjs` 6.2s, `deploy/agent-discovery.mjs` 3.9s,
  `deploy/room-entry.mjs` 3.4s, `server/a2a-jsonrpc.mjs` 2.7s of import-time
  I/O wait — plus ~11s for the route extraction itself). Completes; just slow.
  Worth a perf look if it gates CI, but not a correctness bug.
- `secret-scan-check.mjs`: full-tree secret scan; slow under load, completes solo.
- `reachability.mjs`: full-repo import-graph walk (`report()` runs on every
  invocation regardless of args); slow under load, completes solo.
- `perf-budget.mjs`: boots Playwright + a local server by design; >20s is expected.
- `claims-index.mjs` (all-probes-hang in fuzz): the fuzz worktree had no usable
  `gh`; every probe without `--comments` blocked on the gh subprocess (this is
  BUG-1 above, not load).

## 3. Lenient argv handling (by design, not bugs)

The harness expected nonzero exits for unknown flags / file args, but these
check scripts take no meaningful argv and ignore extras — that is their
contract, not a defect:
- `scan-secrets.mjs`, `docs-link-check.mjs`, `check-wiki.mjs`,
  `untested-modules-lint.mjs`, `journey-coverage.mjs`, `reachability.mjs`
  all exit 0 and perform their fixed check regardless of extra args.
- `flaky-detect.mjs` exits 2 on bad usage (target file missing) — correct.
- `lint.mjs`, `check-deps.mjs`, `openapi-gen.mjs`, `stamp-version.mjs`:
  bad flags surface as nonzero or are passed through to their sub-tools; no
  silent wrong behavior observed.

## 4. Partial writes / concurrency

- No partial writes observed: all file outputs in the slice go through
  single `writeFileSync` of complete content, tmp-file + `renameSync`
  (stamp-version.mjs:57-62), or explicit `--write`/`--out` flags.
  `claims-index.mjs` writes only after a successful fetch (never reached in fuzz).
- Concurrent `--help` runs: all clean (exit 0, no interference).
- Bare-env `--help`: scripts either print usage or fail fast with a clear
  error (exit 1/2/3); none crashed obscurely.
- Garbage stdin (5KB random): no script reads stdin except via explicit
  documented paths; none crashed or hung on it beyond the slow-script timeouts
  in §2.
