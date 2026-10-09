# Guild-09 re-verify — track 3 rollup (10 units)

Method per unit: scratch worktree (detached, registered on the shared
project-room checkout, removed after) → `git checkout -qb` + `git rebase
origin/main` → run every touched my-slice test file FULLY (new-on-branch files
included) → adversarial diff review (test/assert add/remove counts, removed
guard-like lines in server diffs). Per-unit reports in reverify/rev-r*.md.

## Results

| unit | branch | rebase | suites | result |
|---|---|---|---|---|
| r01 | wave500/presence-w7-presence-tests | clean | presence-scale.test.js (new) | **FAIL 3/10** — all 3 are the branch's own "FAIL-FIRST:" aspirational tests (24h churn ghost cleanup, delta subscription, non-heartbeat liveness); not a regression, but branch is not green |
| r02 | wave500/presence-w2-pump | clean | stream-shared-pump.test.js (new) + a2a-card-truth, a2a-jsonrpc, abuse-rate-buckets | green; 1 removed-guard heuristic hit = moved import (false positive, verified) |
| r03 | fo/rel25-feedback-durable | clean | feedback-persistence, feedback-state-registration (new), operator-purge | green |
| r04 | ch-2056/notfound-hint-followup | clean | agent-error-next.test.js | green |
| r05 | qa200-EP-03-invite-unavailable-hint | **CONFLICT** strings/i18n-baseline.json | agent-error-invite-unavailable.test.js (un-rebased) | green on head; owner must rebase + re-bump baseline |
| r06 | qa8/board-terminal-errors | **CONFLICT** server/work-claim-routes.mjs | qa8-board-terminal-errors.test.js (un-rebased) | green on head; owner must resolve (claim-route code) |
| r07 | fix/owner-dm-edit | **CONFLICT** server/store.mjs | owner-dm-edit.test.js (un-rebased) | green on head; owner must resolve |
| r08 | wave300/telemetry-prod | clean | tripwires.test.mjs | green |
| r09 | wave300/fix22c-ci-queue-telemetry | clean | ci-queue-sampler.test.js | green |
| r10 | wave400/elegant-server | clean (8/8; unit's first attempt hit a transient git todo-state) | a2a-card-truth, a2a-jsonrpc, abuse-rate-buckets on rebased head | green; observation: guard-site consolidation (account_session_required 18→13 etc.) consistent with stated dedupe, not call-site verified |

## Breakage reported

1. **r01**: presence-scale.test.js fails 3/10 on current main — intentional
   FAIL-FIRST markers, not regressions. Branch not landable as-is.
2. **r05/r06/r07**: stale branches with genuine rebase conflicts
   (i18n-baseline.json; work-claim-routes.mjs; store.mjs). Suites green on
   their heads; each needs its owner's rebase.
3. No test/assert removals found in any branch diff. No suite that was green
   went red due to a branch's server changes.
