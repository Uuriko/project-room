# Work + public-work modules

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `server/public-work-claim-fence.mjs`  (47 lines)

**Purpose.** Upgrade compatibility for public claim namespaces, not authentication against a database administrator. Existing private claim namespaces keep their rules.

**Exports:** `publicWorkClaimFenceSchema`, `verifyPublicWorkClaimFence`, `withPublicWorkClaimWriter`

**Callers/importers (git grep HEAD):** `cloudflare/public-work-claims.check.mjs`, `scripts/runtime-package.mjs`, `server/public-work-claims.mjs`, `server/room-export.mjs`, `server/store.mjs`, `tests/public-work-claim-fence.test.js`, `tests/public-work-claims.test.js`, `tests/public-work-receipt-retry-invariant.test.js`, `tests/writer-fence-unfenced.test.js`

## `server/public-work-reviews.mjs`  (180 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `PublicWorkReviews`, `publicWorkReviewsSchema`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/store.mjs`, `tests/public-work-reviews.test.js`

## `server/public-work-successors.mjs`  (89 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `PublicWorkSuccessors`, `publicWorkSuccessorsSchema`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/store.mjs`, `tests/public-work-successors.test.js`

## `server/work-claim-mirror.mjs`  (137 lines)

**Purpose.** Projection claim commands (MCP and the work-item form) write the same work-claims board the REST routes use. A handoff or supersede leaves a successor card that depends on the source, so the chain is visible there.

**Exports:** `boardClaimId`, `mirrorProjectionClaim`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/store.mjs`, `tests/claim-scopes.test.js`

## `server/work-claim-sqlite.mjs`  (134 lines)

**Purpose.** Durable work-claim registry. Production RoomStore owns this registry; HTTP and next-actions share it. Claims, leases and review attestations survive Worker eviction and deployment. The Map registry remains a fixture for isolated state-machine tests. Items are stored whole as JSON. The work-claims state machine validates every item it reads (workOf), so a row is never trusted without passing through it first.

**Exports:** `WORK_CLAIM_ROW_KIND`, `createDurableWorkClaimRegistry`, `workClaimSchema`

**Callers/importers (git grep HEAD):** `cloudflare/public-work-claims.check.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/reachability.mjs`, `scripts/runtime-package.mjs`, `server/persisted-row.mjs`, `server/store.mjs`, `tests/chaos/work-claim-chaos-scaffold.mjs`, `tests/claim-pr-sync-room-scoping.test.js`, `tests/persisted-row.test.js`, `tests/public-work-claim-fence.test.js`

## `server/work-declarations.mjs`  (102 lines)

**Purpose.** Step 2 of the matchmaking plan (docs/MATCHMAKING.md): the declarations that the filter in server/work-matchmaking.mjs reads. One side of the market is an agent saying what it can do, how long it will work, and why it is here. The other is a piece of work saying what it needs, how big it is, and who it will let near it. Everything here is NULLABLE on purpose: work that declares nothing keeps working exactly as it does today, claimable by id, and simply never appears in matchmaking. store.mjs imports this module, so this module imports nothing from store.mjs. Pure otherwise: injected clock, caller-owned rows, frozen outputs, domain errors with no HTTP status.

**Exports:** `isMatchable`, `openingsFromRows`, `rowToOpening`, `rowToSeeker`, `seekerToRow`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/matchmaking-routes.mjs`, `server/writer-fence.mjs`, `tests/work-declarations.test.js`

## `server/work-duplicates.mjs`  (91 lines)

**Purpose.** Work-claim duplicate detection — Linear "similar issues" emulation. A pure decider: given the room's work-claim items and a free-text query, returns ranked candidate duplicates with scores in [0, 1]. Pure, dependency-free, deterministic; frozen outputs. The tool suggests; agents decide. Nothing here auto-merges, auto-closes, or auto-links — a candidate is a hint, and marking a real duplicate stays an explicit agent action. Scoring: tokenize (lowercase alphanumeric runs, stopword-stripped), then weighted Jaccard similarity: 0.6 * title overlap + 0.4 * note overlap. Only items at or above minScore are returned, ranked score-descending with id-ascending tie-breaks so repeated calls are byte-identical.

**Exports:** `findDuplicates`, `scoreItem`, `tokenize`, `DuplicateError `

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/work-claim-routes.mjs`, `tests/work-claim-duplicates.test.js`

## `server/work-help.mjs`  (119 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `auditWorkHelp`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `scripts/untested-modules-lint.mjs`, `server/recovery.mjs`, `server/store.mjs`

## `server/work-wants.mjs`  (140 lines)

**Purpose.** BOARD-WAKE-2: opt-in "new ready work" wake. An agent member may set wantsWork { labels, capabilities } for itself in a room. When a Board item is created unassigned, or released back to unclaimed, every opted-in agent whose filter matches gets one wake with reason ready_work, at most once per 10 minutes. Matches inside that window fold into the earlier wake (counted in foldedSinceWake); the agent sees them when it reads the Board. Default off: no row, no wake. labels match the item's tags (any overlap); capabilities match the item's kind (work, land or deploy). An empty list matches everything on that axis. The row is a preference only; the wake goes through enqueueClaimWake, so pause, a read-only tier and room trust skip it exactly as they skip an assignment wake. agent_wants_work is additive and unfenced (server/writer-fence.mjs): older writers have no code path to it, and a missing ro

**Exports:** `WANTS_WORK_KINDS`, `WANTS_WORK_SCHEMA`, `WANTS_WORK_WINDOW_MS`, `WantsWorkInputError`, `clearWantsWork`, `normalizeWantsWork`, `noteReadyWork`, `readWantsWork`, `setWantsWork`, `wantsWorkMatches`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/routes/wants-work.mjs`, `server/store.mjs`, `server/work-claim-routes.mjs`, `tests/board-wake-ready-work.test.js`
