# Fuzz / chaos results — guild-16

Generated 2026-10-09T12:55:12.028Z.

| unit | inputs | verdicts |
|---|---|---|
| f1-cron | 29 | ok:29 |
| f10-growth-faults | 6 | ok:6 |
| f11-scheduler-lifecycle | 11 | ok:11 |
| f12-gates | 10 | ok:10 |
| f13-job-health | 4 | ok:4 |
| f14-scheduler-guards | 7 | ok:7 |
| f15-schedule-overlap | 91 | ok:84 accept:7 |
| f2-due-boundary | 42 | ok:42 |
| f3-alarm | 6 | ok:6 |
| f4-double-fire | 3 | ok:3 |
| f5-missed-runs | 4 | ok:4 |
| f6-clock-jump | 3 | ok:3 |
| f7-job-crash | 1 | ok:1 |
| f8-config | 24 | ok:24 |
| f9-lastran | 13 | ok:12 crash:1 |

**Totals: 254 inputs across 15 units** — ok:246 accept:7 crash:1.

## Non-ok cases

| unit | case | verdict | detail |
|---|---|---|---|
| f15-schedule-overlap | overlap:answer-engine-check.yml<>onboarding-probe.yml | accept | answer-engine-check.yml (0 15 * * 1) can fire the same minute as onboarding-probe.yml (0 15 * * 1) |
| f15-schedule-overlap | overlap:answer-engine-check.yml<>room-github-door.yml | accept | answer-engine-check.yml (0 15 * * 1) can fire the same minute as room-github-door.yml (*/10 * * * *) |
| f15-schedule-overlap | overlap:deploy-drift.yml<>qa2-fuzz.yml | accept | deploy-drift.yml (23 * * * *) can fire the same minute as qa2-fuzz.yml (23 10 * * *) |
| f15-schedule-overlap | overlap:listing-check.yml<>room-github-door.yml | accept | listing-check.yml (0 14 * * 1) can fire the same minute as room-github-door.yml (*/10 * * * *) |
| f15-schedule-overlap | overlap:onboarding-probe.yml<>room-github-door.yml | accept | onboarding-probe.yml (0 15 * * 1) can fire the same minute as room-github-door.yml (*/10 * * * *) |
| f15-schedule-overlap | overlap:room-github-door.yml<>snippet-adoption.yml | accept | room-github-door.yml (*/10 * * * *) can fire the same minute as snippet-adoption.yml (0 13 * * 1) |
| f15-schedule-overlap | overlap:room-github-door.yml<>soak-test.yml | accept | room-github-door.yml (*/10 * * * *) can fire the same minute as soak-test.yml (0 9 * * 1) |
| f9-lastran | getter | crash | Error: x |
