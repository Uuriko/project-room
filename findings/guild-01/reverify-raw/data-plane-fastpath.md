# re-verify wave300/data-plane-fastpath
- merge-base with origin/main: a21c23643b36f18464ee2eee6a6939380a36079c
- origin/main: 68ec17e83
## rebase
- rebase onto origin/main: CLEAN
## slice files changed (origin/main...HEAD)
- server/work-claim-routes.mjs
## diff stat (whole branch)
 docs/openapi.yaml                   |  29 ++++++
 server/mcp-full-profile.mjs         |   2 +
 server/work-claim-routes.mjs        |  53 +++++++----
 tests/work-claims-fast-path.test.js | 185 ++++++++++++++++++++++++++++++++++++
 5 files changed, 338 insertions(+), 17 deletions(-)
## adversarial review
- removed check/assert/fail lines: 0
- added lines in slice: 37
- removed comparison lines (boundary churn): 3
  SMELL: +function handleWorkClaimsCore({ req, res, url, store, roomId, auth, workClaimRoute, workClaimId, helpers, registry: sourceRegistry, pullBatch = { results: [], rateLimitedUntil: null, skipped: false }, deployStatus = null, fast = false }) {
  SMELL: +  // Fast path: closeLiveClaims writes on read paths; skip it.
  SMELL: +  // no events are emitted, so the budget gate is meaningless — skip it.
## affected tests
- tests/work-claim-board.test.js
- tests/work-claim-client.test.js
- tests/work-claim-durable-http.test.js
- PASS: tests/work-claim-board.test.js
- FAIL: tests/work-claim-client.test.js
- PASS: tests/work-claim-durable-http.test.js
## verdict: recorded above
