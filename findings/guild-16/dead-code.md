# Dead-code analysis — workflows slice

Generated 2026-10-09T11:16:33.289Z. Method: for each exported symbol, grep all of server/, src/, cloudflare/, scripts/, tests/, .github/ for references outside the defining file. "Dead" requires zero external references.

## server/jobs.mjs exports

| symbol | external refs | verdict |
|---|---|---|
| JOB_BUDGET_MS | 0 | DEAD? |
| MINUTE_MS | 0 | DEAD? |
| HOUR_MS | 3 | live |
| DAY_MS | 4 | live |
| SAFETY_NET_CRON | 0 | DEAD? |
| SAFETY_NET_MS | 0 | DEAD? |
| ALARM_RETRY_MS | 1 | live |
| JOBS | 6 | live |
| jobByName | 0 | DEAD? |
| jobsFor | 1 | live |
| jobEnabled | 1 | live |
| jobDisabledReason | 1 | live |
| jobNextDue | 1 | live |
| jobIsDue | 1 | live |
| lastRanFrom | 1 | live |
| earliestFutureAlarm | 1 | live |
| startNodeScheduler | 1 | live |
| nodeJobHealth | 1 | live |
| wireNodeJobs | 2 | live |
| DEFAULT_INTERVAL_MS | 2 | live |
| defaultOnAlert | 2 | live |
| defaultGrowthRules | 2 | live |
| createScheduler | 1 | live |

## src/growth-scheduler.js exports — see table above

## Candidate dead symbols (zero external refs)


### JOB_BUDGET_MS (server/jobs.mjs)

- Zero external references found. Verify before removing: check cloudflare/room.mjs and any dynamic import strings.

### MINUTE_MS (server/jobs.mjs)

- Zero external references found. Verify before removing: check cloudflare/room.mjs and any dynamic import strings.

### SAFETY_NET_CRON (server/jobs.mjs)

- Zero external references found. Verify before removing: check cloudflare/room.mjs and any dynamic import strings.

### SAFETY_NET_MS (server/jobs.mjs)

- Defined as `30 * MINUTE_MS` next to SAFETY_NET_CRON. No importer. The cron STRING is what the Worker consumes; the MS constant looks like a leftover from a numeric-schedule design. Evidence: grep finds no reference outside jobs.mjs. Recommendation: remove or wire it (low risk either way — it is exported, so removal is technically breaking for hypothetical external importers; none exist in-repo).

### jobByName (server/jobs.mjs)

- Zero external references found. Verify before removing: check cloudflare/room.mjs and any dynamic import strings.

## Workflows

31 workflow files present. A workflow is "live" if it has triggers (push/PR/schedule/dispatch). All 31 files have an `on:` block (checked by d6/d7/d8 generators). No orphan workflow files found.

## Workflow script references

All `node scripts/*.mjs` references in workflows resolve to existing files.
