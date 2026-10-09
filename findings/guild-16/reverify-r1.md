# reverify-r1: origin/guild-claimsboard/lease-first-reaper

- date: 2026-10-09T11:57:19Z
- origin/main: 1b6eb70ee
- branch tip: 410ab05ca
- note: claim reaper wiring into server/jobs.mjs

HEAD is now at 1b6eb70ee Merge pull request #2224 from Uuriko/product200/contract-f1
## slice diff

```
 server/jobs.mjs | 12 ++++++++++++
 1 file changed, 12 insertions(+)
```

patch lines: 30
apply: applied-clean
## test run
tests: tests/jobs-node-retry.test.js,tests/jobs-parity.test.js,tests/node-jobs-health.test.js,tests/work-claim-reaper.test.js
test exit: REAL-FAILURES — see adversarial review (slice-only patch broke cross-slice import; full rebase conflicts)
```

test at tests/jobs-node-retry.test.js:1:1
✖ tests/jobs-node-retry.test.js (4079.179848ms)
  'test failed'

test at tests/jobs-parity.test.js:1:1
✖ tests/jobs-parity.test.js (4380.563205ms)
  'test failed'

test at tests/node-jobs-health.test.js:1:1
✖ tests/node-jobs-health.test.js (4421.974691ms)
  'test failed'
```

## mechanical checks
non-slice files in branch diff:
docs/WORK-CLAIMS.md
docs/openapi.yaml
scripts/routes-legacy-allowlist.json
scripts/runtime-package.mjs
server/http.mjs
server/land-queue.mjs
server/persisted-row.mjs
server/public-work-claims.mjs
server/work-claim-integrity.mjs
server/work-claim-mirror.mjs

_adversarial review: appended in rollup_

## adversarial review (coordinator)

VERDICT: stale branch, needs rebase. The slice patch (claim-reaper job) applies clean in isolation, but the branch as a whole does NOT rebase onto current main: full-diff apply fails on docs/openapi.yaml, server/land-queue.mjs, server/work-claim-routes.mjs, server/work-claims.mjs, tests/work-claim-board.test.js. Its merge-base predates major work-claims refactors (multiple merge bases). The reaper module imports electClaimSuccessor, which exists only in the branch version of work-claims.mjs — slice-only application breaks the import (harness artifact, confirmed). On the design: the claim-reaper job follows registry conventions (defineJob, enabled/nextDueAt/run, worker+node). Note: 30s cadence as a FAST (non-slow) job means it arms worker alarms every 30s whenever leases are due — deliberate for lease reaping, but it raises the idle wake rate above the twice-an-hour design while claims are active. enabled() uses Date.now() directly instead of the injected now (cf. landDueAt(store, now)) — minor testability inconsistency.
