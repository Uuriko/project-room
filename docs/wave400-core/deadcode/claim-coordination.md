# Dead code — server/claim-coordination.mjs

**None found.** Every export has live external callers (verified by repo-wide grep):

| Export | External refs |
|---|---|
| `settlePullRequest` | 7 |
| `parsePullRequestUrl`, `pullLinks`, `readyClaims` | 5 |
| `usableEtag`, `rateLimitUntil`, `recordPullOutcome`, `pullsReadyToSettle`, `batchPullOutcome`, `fileLeaseConflicts` | 4 |
| `pullRequestOutcomeFromWebhook`, `pullRequestDue` | 3 |
| `nextPullBackoff`, `pullRequestOutcomeFromApi`, `rememberPoll`, `rollupClaimCi`, `fileLeaseConflictBody` | 2 |

Internal helpers (`stamp`, `fileSlots`, `slotsConflict`, `slotLabel`,
`withCurrentPull`) are all called within the module. `PULL_BACKOFF_ANON_MS`
is used by `nextPullBackoff`; `PULL_BACKOFF_STEPS_MS` by the same.
`LIVE_CLAIM_STATES` used in three places. No unreachable branches found.
