# Mutation results — guild-16 (workflows slice)

Generated 2026-10-09T12:44:07.916Z.

| unit | file | killed | survived | skipped |
|---|---|---|---|---|
| m1 | server/jobs.mjs | 0 | 5 | 0 |
| m10 | cloudflare/scheduled-rpc.test-fixture.mjs | 4 | 0 | 0 |
| m11 | .github/workflows/test.yml | 3 | 0 | 0 |
| m12 | .github/workflows/qa2-fuzz.yml | 0 | 3 | 0 |
| m13 | server/jobs.mjs | 2 | 2 | 0 |
| m14 | server/jobs.mjs | 1 | 3 | 0 |
| m15 | src/growth-scheduler.js | 3 | 1 | 0 |
| m2 | server/jobs.mjs | 0 | 5 | 0 |
| m3 | server/jobs.mjs | 1 | 4 | 0 |
| m4 | server/jobs.mjs | 0 | 5 | 0 |
| m5 | server/jobs.mjs | 0 | 5 | 0 |
| m6 | server/jobs.mjs | 3 | 2 | 0 |
| m7 | src/growth-scheduler.js | 5 | 0 | 0 |
| m8 | src/growth-scheduler.js | 2 | 2 | 0 |
| m9 | cloudflare/jobs-alarm.test-fixture.mjs | 4 | 0 | 0 |
| v1 | server/jobs.mjs | 11 | 0 | 0 |
| v2 | src/growth-scheduler.js | 2 | 0 | 0 |

**Totals: 41 killed, 37 survived, 0 skipped** (17 units).

## Survived mutants (test-gap or equivalent — triaged in the coordinator's final report)

| unit | file | mutant |
|---|---|---|
| m1 | server/jobs.mjs | retry-delay-10x |
| m1 | server/jobs.mjs | safetynet-5min |
| m1 | server/jobs.mjs | budget-slashed |
| m1 | server/jobs.mjs | due-now-nopush |
| m1 | server/jobs.mjs | drop-cadence |
| m12 | .github/workflows/qa2-fuzz.yml | schedule-overlap |
| m12 | .github/workflows/qa2-fuzz.yml | schedule-everymin |
| m12 | .github/workflows/qa2-fuzz.yml | schedule-6field |
| m13 | server/jobs.mjs | budget-zero |
| m13 | server/jobs.mjs | reason-null |
| m14 | server/jobs.mjs | scheduler-never-starts |
| m14 | server/jobs.mjs | health-throws-unwired |
| m14 | server/jobs.mjs | gmail-always-null |
| m15 | src/growth-scheduler.js | window-throws |
| m2 | server/jobs.mjs | webhook-null-to-zero |
| m2 | server/jobs.mjs | land-empty-due-now |
| m2 | server/jobs.mjs | claim-empty-due-now |
| m2 | server/jobs.mjs | autolink-empty-due-null |
| m2 | server/jobs.mjs | claim-nan-to-null |
| m3 | server/jobs.mjs | reentrancy |
| m3 | server/jobs.mjs | drop-lastran-success |
| m3 | server/jobs.mjs | record-always-ok |
| m3 | server/jobs.mjs | drop-lastran-fail |
| m4 | server/jobs.mjs | slow-arms-alarm |
| m4 | server/jobs.mjs | alarm-now-nopush |
| m4 | server/jobs.mjs | due-exact-nodue |
| m4 | server/jobs.mjs | cadence-exact-nodue |
| m4 | server/jobs.mjs | earliest-lte |
| m5 | server/jobs.mjs | growth-zero-enabled |
| m5 | server/jobs.mjs | empty-string-no-fallback |
| m5 | server/jobs.mjs | nan-interval-accepted |
| m5 | server/jobs.mjs | double-start |
| m5 | server/jobs.mjs | channel-zero-enabled |
| m6 | server/jobs.mjs | summary-and |
| m6 | server/jobs.mjs | period-10x |
| m8 | src/growth-scheduler.js | triggered-null |
| m8 | src/growth-scheduler.js | surge-zero-threshold |
