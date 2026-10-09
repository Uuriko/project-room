# Mutation testing (guild-11)

15 mutants across server/tripwires.mjs, telemetry/gauges.mjs,
telemetry/validate.mjs, telemetry/collect.mjs,
telemetry/build-dashboard-data.mjs, server/agent-plugin-store.mjs.
Each mutant ran the affected suite under an exclusive file lock; files were
restored after every unit (git tree clean).

## Scoreboard

killed=8 survived=7 (harness=DETECTED means my ad-hoc harness
caught what the suite missed — those are test gaps, not suite kills)

| unit | file | suite verdict | harness | mutant |
|---|---|---|---|---|
| u01 | tripwires.mjs | KILLED | none | gaugeStatus exclusive->inclusive (v>t becomes v>=t) |
| u02 | tripwires.mjs | SURVIVED | none | pruneWindows penalty filter off-by-one (t>=cutoff becomes t>cutoff) |
| u03 | tripwires.mjs | KILLED | none | revert p99 ns->ms fix (p99ns/1e6 becomes p99ns) |
| u04 | tripwires.mjs | KILLED | none | dropped monitor.reset() after percentile sample |
| u05 | tripwires.mjs | KILLED | none | silentTimeoutRatio off-by-one denominator (+1) |
| u06 | tripwires.mjs | KILLED | none | eventBudgetRemainingRatio dropped Math.max(0,...) clamp |
| u07 | tripwires.mjs | KILLED | none | trackCommandOutcome flipped writableEnded conditional |
| u08 | gauges.mjs | SURVIVED | DETECTED | toContractStatus dropped critical->trip mapping |
| u09 | gauges.mjs | SURVIVED | DETECTED | contract view threshold criticalAt->warnAt |
| u10 | validate.mjs | SURVIVED | DETECTED | claim min-length 10->5 |
| u11 | collect.mjs | SURVIVED | DETECTED | extractFinding dropped FINDING prefix gate |
| u12 | build-dashboard-data.mjs | SURVIVED | DETECTED | corrupt JSONL line: throw->skip |
| u13 | agent-plugin-store.mjs | KILLED | none | deliverWakePing dropped WAKE_PING_EVENT filter (only '*' subs served) |
| u14 | agent-plugin-store.mjs | KILLED | none | pruneWebhookDeliveries moreMayRemain === -> > |
| u15 | agent-plugin-store.mjs | SURVIVED | NOT-DETECTED | SKIPPED_RECHECK_MS 10min->1ms |

## Test gaps (survived mutants)

u02 — pruneWindows exact-cutoff boundary (t == cutoff kept vs dropped) untested.
u09 — contract test pins the threshold SHAPE but not which threshold (criticalAt vs warnAt).
u10 — telemetry/validate.mjs has NO automated suite coverage at all.
u11 — collect.mjs FINDING-prefix gate unpinned by tests.
u12 — build-dashboard-data.mjs fail-fast-on-corrupt-line unpinned by tests.
u15 — SKIPPED_RECHECK_MS unpinned by tests.

## Bugs confirmed

None. Every survived mutant was a test-coverage gap, not a behavior bug:
each was verified against the documented contract (gotchas.md) and found
consistent. No BUG CONFIRMED posts were warranted.
