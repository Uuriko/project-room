# Offers, Demigod contracts, trials, next-actions

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `server/demigod-contracts.mjs`  (201 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `DEMIGOD_CONTRACT_STATUSES`, `DemigodContracts`, `demigodContractsSchema`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/demigod-offers.mjs`, `server/store.mjs`, `tests/buyer-offer-http.test.js`

## `server/demigod-offers.mjs`  (284 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `DEFAULT_FEE_POLICY_REF`, `DEMIGOD_OFFER_STATUSES`, `DemigodOffers`, `PRICE_TYPES`, `demigodOffersSchema`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/store.mjs`, `tests/buyer-offer-http.test.js`

## `server/demigod-policy-adapter.mjs`  (75 lines)

**Purpose.** server/demigod-policy-adapter.mjs — Demigod's jobs policy mapped onto the room's fee shape. RECORD-ONLY: every export COMPUTES what a fee would be. Nothing here collects, charges, moves, or settles money — collection needs John's funding tap. All amounts are decimal STRINGS of minor units (e.g. cents); math is exact BigInt integer arithmetic, never floats. Demigod's policy (as briefed): a 10% placement fee on placement value. Trial work carries a management fee that is creditable against a later placement fee (Lemon.io shape).

**Exports:** `DEMIGOD_PLACEMENT_FEE_BPS`, `DEMIGOD_POLICY_VERSION`, `placementFeeBreakdown`, `trialManagementFee`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/demigod-policy-adapter.mjs`, `server/fee-credit-ledger.mjs`, `server/trial-task-store.mjs`, `tests/demigod-jobs-money.test.js`

## `server/handoff-case.mjs`  (78 lines)

**Purpose.** CASE handoff contract (research slice R2). Handoffs are freeform text and the receiver re-asks everything; CASE fixes the shape: Customer/auth, Aim/urgency, Steps/sources, Escalation/ownership — with an epistemic label on every step, so a verified fact never reads the same as a guess. Pure module: no database, no network, no clock. Validation raises ServiceError (422) from ./store.mjs so the same codes read in unit tests and through the journal/store layer. Unknown keys and unknown epistemic labels are rejected, never silently accepted — an unlabeled step is the failure mode this contract exists to kill.

**Exports:** `caseOf`, `caseVersion`, `epistemicLabels`, `validateCase`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/inbox-handoff.mjs`, `tests/handoff-case.test.js`

## `server/matchmaking-routes.mjs`  (169 lines)

**Purpose.** Matchmaking HTTP routes: the arrival surface. Three modules were built and green and unreachable — an agent could not declare what it wants, a room could not declare what an opening needs, and nothing paired them. This mounts them under api/rooms/{roomId}/matchmaking/* in the same pattern as server/work-claim-routes.mjs: room-scoped handlers mounted by server/http.mjs inside the authenticated room block, after the shared credential, fence and rate-limit checks. Identity: the seeker is always the authenticated member (auth.member.id). A caller cannot declare on another agent's behalf, so the seekerId is never read from the body — matching for someone else is a different feature and needs its own consent story. Error contract: the pure modules throw Error with a plain message and no HTTP status. Bad input maps to 422 invalid_matchmaking_input; an unknown work item or decision to 404; a cal

**Exports:** `createMatchmakingRegistry`, `handleMatchmaking`, `handleMatchmakingCore`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/http.mjs`, `tests/matchmaking-routes.test.js`

## `server/next-actions-routes.mjs`  (93 lines)

**Purpose.** HTTP routes for next-actions (RC-2026-09-25-911): the room's ranked per-agent "what should I do next" surface. Mounted from server/http.mjs via createNextActionsRoutes, which receives the server's local helpers. handleNextActionsRoutes returns true when it served the request, false so http.mjs can fall through to other routes. Paths follow the room's flat /api/rooms/{roomId}/<route> convention: GET  /api/rooms/{roomId}/next-actions               ranked list (room-next-actions/1) POST /api/rooms/{roomId}/next-actions-dismiss      {actionId, expiresInDays?, forever?, reason?} GET  /api/rooms/{roomId}/next-actions-suppressions read-back (newest first) PUT  /api/rooms/{roomId}/next-actions-suppressions {suppressions:[{kind, reason?}]} (replace-all) GET  /api/rooms/{roomId}/next-actions-dismissals   read-back incl. lapsed rows Auth is the caller's room credential (Bearer identity secret or ro

**Exports:** `createNextActionsRoutes`

**Callers/importers (git grep HEAD):** `scripts/reachability.mjs`, `scripts/route-docs-check.mjs`, `scripts/routes-inventory.mjs`, `scripts/runtime-package.mjs`, `server/http.mjs`, `tests/developer-contract.test.js`, `tests/invite-only-boundary.test.js`

## `server/project-offers.mjs`  (197 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `ProjectOffers`, `projectOffersSchema`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `scripts/untested-modules-lint.mjs`, `server/demigod-offers.mjs`, `server/store.mjs`

## `server/trial-task-store.mjs`  (111 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `TrialTasks`, `railActor`, `railFail`, `trialTaskSchema`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/buyer-signoff.mjs`, `server/demigod-contracts.mjs`, `server/demigod-offers.mjs`, `server/routes/record-rails.mjs`, `server/store.mjs`, `tests/trial-task-http.test.js`

## `server/trial-tasks.mjs`  (301 lines)

**Purpose.** Trial tasks — Demigod x Project Room paid-trial rails (option 4, Lemon.io shape). RECORD-ONLY: no money moves in this build, ever. `funded` means "trial budget recorded" — a bookkeeping note that a budget exists, never a ledger movement, escrow, or payout. Every money-adjacent field is a record, not a transaction: - budgetRecord: the recorded budget note (currency/amountBps are descriptive strings; nothing is debited, held, or transferred). - feePolicyRef: an opaque pointer to the fee policy (Lane D owns the policy itself); this module never computes or applies a fee. - vettingRubric weights and rubricScores: basis points as STRINGS (the receipt-standard bans JSON numbers in signed bodies); scoring only, no amounts move. Lifecycle: proposed -> funded -> claimed -> submitted -> verdict -> receipted, plus blocked (parks, resumable) and released (terminal). A failed verdict still receipts: 

**Exports:** `TRIAL_TASK_STATES`, `TrialTaskError`, `blockTrialTask`, `claimTrialTask`, `createTrialTask`, `createTrialTaskRegistry`, `fundTrialTask`, `receiptTrialTask`, `releaseTrialTask`, `resumeTrialTask`, `submitTrialTask`, `verdictTrialTask`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/trial-task-store.mjs`, `tests/trial-tasks.test.js`
