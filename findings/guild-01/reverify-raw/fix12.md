# re-verify wave300/fix12-unprivileged-succession
- merge-base with origin/main: b5c215f828ac66081a18ad3ab8cfe723d8d12211
- origin/main: 438081a3b
## rebase
- rebase onto origin/main: CONFLICT
  
- fallback merge origin/main: CLEAN (tests run on merged tree)
## slice files changed (origin/main...HEAD)
- server/work-claim-routes.mjs
- server/work-claims.mjs
## diff stat (whole branch)
 server/work-claim-routes.mjs        |  93 +++++++++++++++++-
 server/work-claims.mjs              |  20 ++++
 src/events.js                       |   2 +-
 tests/work-claim-succession.test.js | 184 ++++++++++++++++++++++++++++++++++++
 7 files changed, 372 insertions(+), 3 deletions(-)
## adversarial review
- removed check/assert/fail lines: 0
- added lines in slice: 113
- removed comparison lines (boundary churn): 0
## affected tests
- tests/claims-state-machine.property.test.js
- tests/work-claim-board.test.js
- tests/work-claim-client.test.js
- tests/work-claim-durable-http.test.js
- tests/work-claim-guards.test.js
- tests/work-claim-leases.test.js
- tests/work-claims.test.js
- FAIL: tests/claims-state-machine.property.test.js
