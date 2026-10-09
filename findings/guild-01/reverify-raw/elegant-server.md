# re-verify wave400/elegant-server
- merge-base with origin/main: c5d1c313a639faa8d8d1d89cf0fa6086cec3f8be
- origin/main: be7ce3b17
## rebase
- rebase onto origin/main: CONFLICT
  CONFLICT (content): Merge conflict in server/http.mjs
- fallback merge origin/main: CONFLICT — BREAKAGE: branch cannot be integrated without manual resolution
## slice files changed (origin/main...HEAD)
- server/claim-coordination.mjs
- server/work-claim-events.mjs
- server/work-claim-integrity.mjs
- server/work-claim-mirror.mjs
- server/work-claim-routes.mjs
- server/work-claim-sqlite.mjs
- server/work-claims.mjs
## diff stat (whole branch)
 server/work-claim-sqlite.mjs     |  11 +-
 server/work-claims.mjs           | 379 +++++++++++++------------
 tests/work-claim-guards.test.js  |  43 +++
 tests/work-claim-mirror.test.js  | Bin 0 -> 4618 bytes
 14 files changed, 823 insertions(+), 917 deletions(-)
## adversarial review
- removed check/assert/fail lines: 62
- added lines in slice: 454
- removed comparison lines (boundary churn): 160
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
  SMELL: +      ? { results: [], rateLimitedUntil: budget, skipped: true }
## affected tests
- tests/claim-settle-1526.test.js
- tests/claims-state-machine.property.test.js
- tests/work-claim-batch-outcome.test.js
- tests/work-claim-board.test.js
- tests/work-claim-client.test.js
- tests/work-claim-durable-http.test.js
- tests/work-claim-events.test.js
- tests/work-claim-guards.test.js
- tests/work-claim-leases.test.js
- tests/work-claim-retention.test.js
- tests/work-claim-settle-retry.test.js
- tests/work-claims.test.js
- SKIPPED (branch does not integrate)
## verdict: recorded above
