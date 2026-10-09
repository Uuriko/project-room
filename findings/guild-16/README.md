# guild-16 findings — workflows slice

Scope: `.github/workflows/`, `server/jobs*.mjs`, `server/*schedul*.mjs` (→ `src/growth-scheduler.js`), cloudflare jobs-alarm/scheduled-rpc checks, docs/weekly-learnings-cron.md.

Generated 2026-10-09T12:55:12.295Z.

## Documents

| file | contents |
|---|---|
| [jobs-registry.md](jobs-registry.md) | Every job: schedule, purpose, runtimes, gates, failure modes, retry |
| [scheduler-mechanics.md](scheduler-mechanics.md) | Worker alarms vs node scheduler, at-most-once, budgets, health endpoint |
| [growth-scheduler.md](growth-scheduler.md) | Growth watcher wiring, cadence, fault containment |
| [cloudflare-cron-probes.md](cloudflare-cron-probes.md) | The two workerd proofs: what each proves |
| [weekly-learnings-cron.md](weekly-learnings-cron.md) | Doc-vs-script verification for the out-of-repo cron |
| [workflows-ci.md](workflows-ci.md) | CI/gate workflow catalog |
| [workflows-scheduled.md](workflows-scheduled.md) | Scheduled probe workflow catalog |
| [workflows-deploy.md](workflows-deploy.md) | Deploy/release/relay workflow catalog |
| [dead-code.md](dead-code.md) | Reachability evidence per slice export |
| [mutants.md](mutants.md) | Mutation testing rollup |
| [fuzz.md](fuzz.md) | Fuzz/chaos rollup |
| [reverify.md](reverify.md) | Branch re-verification rollup |

## Method

- **Mutation:** 15 units × mutdriver (literal find/replace mutants: off-by-one, flipped conditionals, dropped awaits/updates, schedule changes), each run against the affected test file(s) with worktree-local TMPDIR. Survived mutants triaged as real-bug → fail-first regression test, equivalent, or test gap.
- **Fuzz/chaos:** 15 units — malformed crons, due-boundary sweeps, double-fire, missed runs, clock jumps, mid-run crashes, hostile config, hostile persisted state, lifecycle, fail-closed gates, health endpoint, schedule overlap.
- **Re-verify:** 10 units — scratch worktree per branch, slice diff rebased onto current origin/main, full affected suite, adversarial diff review.
- **Docs:** 10 units — generated from source with self-checks.
