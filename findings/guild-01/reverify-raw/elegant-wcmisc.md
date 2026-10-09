# re-verify wave400/elegant-wcmisc
- merge-base with origin/main: c5d1c313a639faa8d8d1d89cf0fa6086cec3f8be
- origin/main: e5d59b528
## rebase
- rebase onto origin/main: CLEAN
## slice files changed (origin/main...HEAD)
- server/claim-coordination.mjs
- server/work-claim-events.mjs
- server/work-claim-integrity.mjs
- server/work-claim-mirror.mjs
- server/work-claim-sqlite.mjs
- server/work-claims.mjs
## diff stat (whole branch)
 server/work-claim-mirror.mjs     |  31 ++--
 server/work-claim-sqlite.mjs     |  11 +-
 server/work-claims.mjs           | 379 +++++++++++++++++++--------------------
 tests/work-claim-mirror.test.js  | Bin 0 -> 4618 bytes
 12 files changed, 457 insertions(+), 550 deletions(-)
## adversarial review
- removed check/assert/fail lines: 62
- added lines in slice: 268
- removed comparison lines (boundary churn): 124
  REMOVED: -  check(Array.isArray(value), "tags must be an array");
  REMOVED: -  check(value.length <= MAX_RECEIPT_TAGS, `tags must hold at most ${MAX_RECEIPT_TAGS} tags`);
  REMOVED: -  value.forEach(tag => check(typeof tag === "string" && TAG_PATTERN.test(tag),
  REMOVED: -  check(Array.isArray(value), "files must be an array");
  REMOVED: -  check(value.length <= MAX_CLAIM_FILES, `files must list at most ${MAX_CLAIM_FILES} paths`);
  REMOVED: -  check(value !== null && typeof value === "object" && !Array.isArray(value), "fileBlocks must be an object");
  REMOVED: -  check(typeof value === "string" && NAME_PATTERN.test(value), "repo must be 1..200 characters of letters, numbers, or . _ / -");
  REMOVED: -  check(typeof value === "string" && NAME_PATTERN.test(value), "branch must be 1..200 characters of letters, numbers, or . _ / -");
  REMOVED: -  check(Array.isArray(value), "dependsOn must be an array");
  REMOVED: -  check(value.length <= MAX_DEPENDS, `dependsOn must list at most ${MAX_DEPENDS} claims`);
## affected tests
- tests/claim-settle-1526.test.js
- tests/claims-state-machine.property.test.js
- tests/work-claim-batch-outcome.test.js
- tests/work-claim-board.test.js
- tests/work-claim-durable-http.test.js
- tests/work-claim-events.test.js
- tests/work-claim-guards.test.js
- tests/work-claim-leases.test.js
- tests/work-claim-retention.test.js
- tests/work-claim-settle-retry.test.js
- tests/work-claims.test.js
- PASS: tests/claim-settle-1526.test.js
- FAIL: tests/claims-state-machine.property.test.js
- PASS: tests/work-claim-batch-outcome.test.js
- PASS: tests/work-claim-board.test.js
- PASS: tests/work-claim-durable-http.test.js
- PASS: tests/work-claim-events.test.js
- PASS: tests/work-claim-guards.test.js
- PASS: tests/work-claim-leases.test.js
- PASS: tests/work-claim-retention.test.js
- PASS: tests/work-claim-settle-retry.test.js
- PASS: tests/work-claims.test.js
## verdict: recorded above
