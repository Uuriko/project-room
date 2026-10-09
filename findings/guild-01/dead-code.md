# Dead code — claim-core slice

Reachability analysis over `server/` + `src/` + `tests/` (2026-10-09):
for every export of every slice module, every file importing that module
was checked for actual references; private functions were checked for
intra-file call sites. Evidence script:
`findings/guild-01/tools/reach.mjs`; raw output
`findings/guild-01/dead-code-evidence.txt`.

## Confirmed dead (1)

**`workClaimRegistry`** — `server/work-claim-routes.mjs:106`
(`export const workClaimRegistry = defaultRegistry;`)

Evidence: repo-wide grep for the identifier across `*.mjs/*.js/*.ts/*.json/*.md`
returns exactly one hit — its own declaration. No importer in `server/`,
`src/`, `tests/`, docs, or OpenAPI. The module's live registry surface is
`createWorkClaimRegistry()` (used by the HTTP layer and tests) and the
`registry` parameters threaded through `closeWorkClaim` /
`linkWorkClaimPullRequest` / `handleWorkClaims`; the singleton export is
unreferenced. Safe to delete (one-line removal; no callers to migrate).

## Investigated, NOT dead

13 exports initially flagged "no importers" by the naive heuristic — all
explained:

- Used **intra-module** (declaration + internal call sites; the heuristic
  excluded the defining file): `MAX_PROVENANCE_WALK`, `REVIEW_VERDICTS`,
  `namedReviewers` (called by `resolveNamedReviewers`),
  `CLAIM_EVENT_COALESCE_MS`, `claimEventCoalesced` (called by
  `emitWorkClaimEvent`), `BOARD_LEASE_HOURS_MIN`, `DEPLOY_STATUS_MAX_AGE_MS`,
  `PULL_POLL_BACKOFF_MS` (used in `rateLimitUntil`), `CI_STATES`,
  `REVIEW_VERDICTS`, `fileWarningsFor` (called at routes:1036),
  `HARD_WORK_TAGS` (used by `isHardWork`).
- Exported API constants referenced cross-module or in tests (2+ files
  each): `WORK_CLAIM_ACTIONS`, `DONE_WINDOW_MS`, `LIST_HISTORY_ENTRIES`,
  `PULL_MISSING_BACKOFF_MS`, `PULL_CANDIDATE_CAP`, `enqueueClaimWake`,
  `wakeNamedReviewers`, `boardClaimId`, `roomEventsRemaining`, `usableEtag`.

Private helpers `pageBoard` / `pageReady` (routes) are called from
`buildWorkClaimPage` — not dead (an early regex miscounted them).

## Verdict

The slice is tight: 1 dead export out of ~120. No dead private functions,
no orphaned modules. `work-claim-digest.mjs` does not exist on main (it
appears only on the unmerged `wave300/fix69-event-light-claims` branch).
