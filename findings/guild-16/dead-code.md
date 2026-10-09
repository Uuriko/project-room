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

## Candidate dead symbols (zero external refs — corrected with internal-use check)

**Genuinely unreferenced anywhere in the repo:**

### jobByName (server/jobs.mjs)

- Zero references in server/, src/, cloudflare/, scripts/, tests/, .github/. The registry
  is consumed via `JOBS`, `jobsFor`, `jobEnabled`, etc. Safe to remove; harmless to keep.

### SAFETY_NET_MS (server/jobs.mjs)

- Defined as `30 * MINUTE_MS` next to SAFETY_NET_CRON. No importer. Leftover from a
  numeric-schedule design.

### SAFETY_NET_CRON (server/jobs.mjs) — documentation-only, drift risk

- The exported constant is imported nowhere. The PRODUCTION safety-net cron lives in
  `cloudflare/wrangler.jsonc` (`triggers.crons: ["*/30 * * * *"]`, asserted by
  `cloudflare/http.check.mjs:422`). The constant duplicates that truth as documentation
  next to the scheduler code. If the wrangler cron ever changes, the constant silently
  lies. Recommendation: derive one from the other, or delete the constant.

**NOT dead (used internally in jobs.mjs, just not imported elsewhere):**
- `JOB_BUDGET_MS` (3 uses: defineJob default), `MINUTE_MS` (cadences). Internal use
  keeps them live; "external refs" counts only cross-file imports.

## Workflows

31 workflow files present. A workflow is "live" if it has triggers (push/PR/schedule/dispatch). All 31 files have an `on:` block (checked by d6/d7/d8 generators). No orphan workflow files found.

## Workflow script references

All `node scripts/*.mjs` references in workflows resolve to existing files.
