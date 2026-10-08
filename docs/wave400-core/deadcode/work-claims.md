# Dead-code candidates — server/work-claims.mjs

Method: every `export` in the file was grepped for references outside
`server/work-claims.mjs` across server/, client/, tests/, bin/, cli/, ops/,
scripts/, evals/ (2026-10-08, branch wave400/docs-core). Internal uses inside
the module disqualify a name from "dead" even with zero external callers.

## Definitely dead

None found. Every internal helper (check, fail, toMs, nowMsOf, isoOf, idOf,
kindOf, revisionOf, ciOf, reviewBasisOf, reviewBasisFor, sameBasis,
currentReviewBasis, reviewRecordOf, reviewsOf, attestationOf, readingAcksOf,
normalizeClaimPath, claimedFilesOf, fileBlocksOf, repoOf, branchOf,
dependsOnOf, parentClaimIdOf, evidenceRefsOf, premiseFlagOf, pullRequestOf,
pullRequestsOf, chainOf, optionalId, blobsOf, tagsOf, agentOf, stamp,
withHistory, historyOmittedOf, positiveCap, leaseHoursOf, pullList,
handleSlug) is called at least once within the module.

## Probably dead / needs owner confirm

All of these are exported but have no production caller (server/, client/,
bin/, cli/, ops/, scripts/, evals/). They may be kept intentionally as
public API for external agents/tools; removal is a breaking change.

- `server/work-claims.mjs:54` — `CLAIM_VERBS`: exported constant, zero
  internal uses, zero external references outside
  `tests/claims-state-machine.property.test.js`.
- `server/work-claims.mjs:44` — `REVIEW_VERDICTS`: exported constant, zero
  references anywhere outside the module (not even tests).
- `server/work-claims.mjs:43` — `CI_STATES`: exported constant, zero
  references anywhere outside the module (not even tests).
- `server/work-claims.mjs:~972` — `workOwnedBy(items, agentId)`: only callers
  are `tests/work-claim-leases.test.js` and `tests/work-claims.test.js`. No
  production caller.
- `server/work-claims.mjs:~977` — `unclaimedWork(items)`: only callers are
  `tests/work-claim-leases.test.js` and `tests/work-claims.test.js`. No
  production caller.
- `server/work-claims.mjs:~87` — `DELIVERY_MODES`: only referenced in
  `tests/work-claim-leases.test.js`.
- `server/work-claims.mjs:~90` — `DEFAULT_MAX_MEMBER_OPEN_CLAIMS`: only
  referenced in `tests/work-claim-guards.test.js`.

## Checked and alive (zero external callers but used inside the module)

- `HARD_WORK_TAGS` — used by `isHardWork` (which has production callers in
  server/needs-me.mjs, server/work-claim-routes.mjs).
- `MAX_PROVENANCE_WALK` — used by `walkProvenance` (MCP + route callers).
- `namedReviewers` — used by `resolveNamedReviewers` (server/needs-me.mjs,
  server/work-claim-events.mjs).
- `CLAIM_LIFECYCLE` — used by `nextClaimState` (used in `closeWork`).
- `nextClaimState`, `creatorOf` — used internally (`closeWork`) plus property
  tests.
- `stampClaimHistory` — used by `server/required-reading.mjs`.
- `summarizeClaimHistory` — used by `server/work-claim-routes.mjs`.
- `isReceiptTag` — used by `server/work-claim-routes.mjs` (receipts query).
- `DEFAULT_MAX_OPEN_CLAIMS` — used internally by `roomWorkClaimConfig` plus
  `tests/work-claim-guards.test.js`.
- `TERMINAL_CLAIM_STATES`, `TRANSITIONS`, `STATES`, `REVIEW_POLICIES`,
  `CLAIM_KINDS`, `DEFAULT_LEASE_HOURS`, `MAX_LEASE_HOURS`,
  `ACTIVE_CLAIM_STATES` — referenced from production server code and/or
  scripts.
