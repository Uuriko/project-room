# re-verify wave300/sharded-claim-boards
- merge-base with origin/main: cb05aa5bf26f5fd871c0ae19fde174923a3629d0
- origin/main: 76326d6e5
## rebase
- rebase onto origin/main: CONFLICT
  CONFLICT (content): Merge conflict in server/work-claim-routes.mjs
- fallback merge origin/main: CONFLICT — BREAKAGE: branch cannot be integrated without manual resolution
## slice files changed (origin/main...HEAD)
- server/work-claim-routes.mjs
- server/work-claim-sqlite.mjs
- server/work-claims.mjs
## diff stat (whole branch)
 server/work-claim-routes.mjs    | 149 ++++++++++++++++++++++++++++++++-------
 server/work-claim-sqlite.mjs    |  71 +++++++++++++++----
 server/work-claims.mjs          |  44 ++++++++++--
 tests/work-claim-boards.test.js | 151 ++++++++++++++++++++++++++++++++++++++++
 7 files changed, 493 insertions(+), 55 deletions(-)
## adversarial review
- removed check/assert/fail lines: 0
- added lines in slice: 227
- removed comparison lines (boundary churn): 8
## affected tests
- tests/claims-state-machine.property.test.js
- tests/work-claim-board.test.js
- tests/work-claim-client.test.js
- tests/work-claim-durable-http.test.js
- tests/work-claim-guards.test.js
- tests/work-claim-leases.test.js
- tests/work-claim-retention.test.js
- tests/work-claims.test.js
- SKIPPED (branch does not integrate)
## verdict: recorded above
