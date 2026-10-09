# re-verify wave400/perf-stmt-cache-r2
- merge-base with origin/main: c5d1c313a639faa8d8d1d89cf0fa6086cec3f8be
- origin/main: 21d94657e
## rebase
- rebase onto origin/main: CLEAN
## slice files changed (origin/main...HEAD)
- server/work-claim-sqlite.mjs
## diff stat (whole branch)
 perf/WAVE400-PERF-BRIEF.md   | 58 +++++++++++++++++++++++++++++++++++++++++
 perf/wave400-stmt-cache.mjs  | 62 ++++++++++++++++++++++++++++++++++++++++++++
 perf/wave400-stmt-which.mjs  | 18 +++++++++++++
 server/work-claim-sqlite.mjs | 18 ++++++++++---
 4 files changed, 153 insertions(+), 3 deletions(-)
## adversarial review
- removed check/assert/fail lines: 0
- added lines in slice: 16
- removed comparison lines (boundary churn): 3
## affected tests
- tests/work-claim-durable-http.test.js
- tests/work-claim-retention.test.js
- PASS: tests/work-claim-durable-http.test.js
- PASS: tests/work-claim-retention.test.js
## verdict: recorded above
