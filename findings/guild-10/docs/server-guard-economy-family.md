# Guards, budgets and the spend primitive

_Guild-10 doc-coverage page (wave1000). Generated 2026-10-09 from module header comments,
export lists, and `git grep` caller evidence. Each module below had no dedicated doc page.
Purpose/invariants/gotchas are quoted from the module's own header comment where present._

## `server/abuse-rate-buckets.mjs`  (110 lines)

**Purpose.** Abuse rate-limit buckets that must survive Durable Object eviction. Created on first use, not in the constructor. A room that has never tripped one of these limits has no table. The in-memory map in server/http.mjs stays the hot path. A bucket is written here every quarter of its allowance, and again when the allowance is exhausted, so a restart cannot hand the caller a fresh budget. A flood of single attempts does not write a row.

**Exports:** `ABUSE_RATE_FAMILIES`, `ABUSE_RATE_TABLES`, `abuseRateTablesPresent`, `ensureAbuseRateSchema`, `loadAbuseRateBucket`, `pruneAbuseRateBuckets`, `saveAbuseRateBucket`

**Callers/importers (git grep HEAD):** `cloudflare/room.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/http.mjs`, `server/jobs.mjs`, `server/room-export.mjs`, `server/writer-fence.mjs`, `tests/abuse-rate-buckets.test.js`

## `server/buyer-signoff.mjs`  (248 lines)

_No header comment — purpose inferred from exports below._

**Exports:** `BuyerSignoff`, `SIGNOFF_STATUSES`, `buyerSignoffSchema`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/demigod-offers.mjs`, `server/store.mjs`, `tests/buyer-offer-http.test.js`

## `server/channel-send-budgets.mjs`  (132 lines)

**Purpose.** Per-connection send budgets (TASKS item #41). A thin policy layer over the token-bucket limiter (server/token-bucket.mjs) for the POST /api/inbox/channel-sends path: every (channel, account, connection) gets its own bucket, so one noisy bot can never spend another connection's budget or hammer the provider into a ban. Exhaustion is an honest HTTP 429 with a Retry-After header instead of a provider-side throttle. Config knobs, in precedence order: 1. Per-connection overrides: the JSON object in the CHANNEL_SEND_BUDGETS env var, keyed "channel:connectionId" (e.g. {"telegram:conn-9": {"perMin": 10, "burst": 5}}). The registry also honors a stored connection record's `sendBudget` bag when the connection contract starts carrying it (today the contract rejects extra keys, so this lookup is a no-op placeholder for that slice). 2. Channel env knobs: TELEGRAM_SEND_BUDGET_PER_MIN / TELEGRAM_SEND_B

**Exports:** `DEFAULT_SEND_BUDGET_BURST`, `DEFAULT_SEND_BUDGET_PER_MIN`, `GMAIL_BUDGET_PENDING_APPROVAL`, `createSendBudgetRegistry`, `parseConnectionBudgets`, `resolveSendBudget`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/governance.mjs`, `server/http.mjs`, `server/routes/inbox.mjs`, `tests/channel-send-budgets.test.js`

## `server/fee-credit-ledger.mjs`  (175 lines)

**Purpose.** server/fee-credit-ledger.mjs — Lemon.io-shaped trial-fee credit ledger. RECORD-ONLY: this ledger RECORDS trial fees and the credits applied against placement fees. It never collects, holds, or pays out money — collection needs John's funding tap. Pure module, no I/O: the journal lives in memory inside the ledger instance created by createFeeCreditLedger. Shape: a client pays a trial management fee (see server/demigod-policy-adapter.mjs trialManagementFee); the fee becomes a credit the client can apply against a later placement fee. Credits expire (default 180 days); every credit is single-use. Invariants: - append-only journal; balances are DERIVED from the journal, never stored. - a credit can never exceed the fee paid (per trial fee AND in total). - double-apply of the same trial fee is rejected. - expired credits are not applied and contribute nothing to the balance. - every journal e

**Exports:** `CREDIT_EXPIRY_DAYS`, `createFeeCreditLedger`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/demigod-policy-adapter.mjs`, `server/fee-credit-ledger.mjs`, `server/trial-task-store.mjs`, `tests/demigod-jobs-money.test.js`

## `server/ip-blocklist.mjs`  (163 lines)

**Purpose.** Shared SSRF IP blocklist (RC-2026-09-25, H-1/M-1). One canonical place for "is this IP literal in a range we never dial": private, loopback, link-local, multicast, reserved, documentation, CGNAT, benchmarking space, plus every IPv4-embedded-in-IPv6 form (mapped, NAT64 incl. local-use /48, 6to4, deprecated v4-compatible) and Teredo. Used by the web-fetch path (server/web-fetch.mjs) and the webhook path (server/outbound-webhooks.mjs, server/webhook-dispatch.mjs) so a hardening fix can never land in one and miss the other again — that is exactly how the webhook IPv6 bypass shipped while web-fetch was safe. Also home to pinnedLookup (the dns.lookup-compatible function that only answers with already-checked addresses) and isWorkersRuntime (pinning is a Node-only defence; on Workers the egress sandbox is the backstop). Pure: no I/O, no imports, safe on Node and Workers. Strict dotted-quad -> u

**Exports:** `extractEmbeddedIpv4`, `isBlockedIp`, `isBlockedIpv4Value`, `isBlockedIpv6Value`, `isWorkersRuntime`, `parseIpv4`, `parseIpv6`, `pinnedLookup`

**Callers/importers (git grep HEAD):** `cloudflare/webhook-doh.check.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `scripts/untested-modules-lint.mjs`, `server/http.mjs`, `server/outbound-webhooks.mjs`, `server/web-fetch.mjs`, `server/webhook-dispatch.mjs`

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

## `server/room-flood-guard.mjs`  (32 lines)

**Purpose.** Per (room, member) budget for live chat posts and replies. One looping member — human or agent — cannot fill a room. The bucket is in memory and resets when the process or Durable Object is evicted. There are no tiers, no settings, and no counter. Burst 30, refill 1 post per 2 seconds. Only message.posted (a reply is that command with replyToId) and dm.posted spend a token. Reactions, edits, deletes, reads, and work or claim commands do not. System writes, importEvents, and projection replay never call consume. store.command returns an idempotent replay before consume, so that command id is free.

**Exports:** `createRoomFloodGuard`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/store.mjs`, `tests/room-flood-guard.test.js`

## `server/settlement-router.mjs`  (77 lines)

**Purpose.** server/settlement-router.mjs — custody-vs-record-only settlement router. RECORD-ONLY: this router ALWAYS returns the record-only route. Custody (holding client funds, collecting fees, paying out talent) is unimplemented BY DESIGN in this build. Collection needs John's funding tap. What John must approve before CUSTODY_ENABLED may flip to true: 1. funded pool — a real, funded settlement pool exists with a named custodian and published account/rail details; 2. collection authority — John's explicit tap authorizing the room to collect fees from clients; 3. payout authority — John's explicit tap authorizing the room to pay talent and providers out of the pool. Flipping the flag is a POLICY CHANGE, not a rewrite: routeSettlement branches on CUSTODY_ENABLED, and the custody branch below is already shaped. Nothing at the call sites changes.

**Exports:** `CUSTODY_ENABLED`, `CUSTODY_REQUIREMENTS`, `routeSettlement`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/settlement-router.mjs`, `server/trial-task-store.mjs`, `tests/demigod-jobs-money.test.js`

## `server/spend-pricing.mjs`  (67 lines)

**Purpose.** Spend-pricing kill switch: the owner-only emergency lever for the priced-tool gate (promised to Dot's QA lane, room seq 2748). The owner records { enabled: boolean } as a room event (room.spend_pricing_set); the projection carries it (src/events.js spendPricingEnabled, default enabled when absent). While disabled, server/spend-grants.mjs prices nothing: priceForTool(name, state) returns null for every tool, so chargeSpendBeforeCall returns null at the trust boundary — tools forward free, no grants are consulted, no rows are written. Re-enabling restores exact current behaviour. No new tables, no schema bump (event-sourced like server/spend-allowance.mjs). This module does not import server/store.mjs (store imports it); errors carry status and code like ServiceError and the router reads them as such.

**Exports:** `SpendPricingError`, `readSpendPricing`, `setSpendPricing`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/routes/spend-pricing.mjs`, `server/routes/table.mjs`, `tests/spend-pricing.test.js`

## `server/wake-queue-limits.mjs`  (9 lines)

**Purpose.** Wake-queue capacity and timing limits. Leaf module: the enforcing constants live here so light consumers (discovery, governance) can import them without pulling in server/store.mjs (node:sqlite). server/wake-queue.mjs re-exports this object; the values below are the single source of truth the WakeQueue class enforces.

**Exports:** `wakeQueueLimits`

**Callers/importers (git grep HEAD):** `scripts/candidate-runtime-fixture.mjs`, `scripts/runtime-package.mjs`, `server/governance.mjs`, `server/wake-queue.mjs`, `tests/discoverability.test.js`

## `server/work-claim-mirror.mjs`  (137 lines)

**Purpose.** Projection claim commands (MCP and the work-item form) write the same work-claims board the REST routes use. A handoff or supersede leaves a successor card that depends on the source, so the chain is visible there.

**Exports:** `boardClaimId`, `mirrorProjectionClaim`

**Callers/importers (git grep HEAD):** `scripts/runtime-package.mjs`, `server/store.mjs`, `tests/claim-scopes.test.js`

## `server/work-claim-sqlite.mjs`  (134 lines)

**Purpose.** Durable work-claim registry. Production RoomStore owns this registry; HTTP and next-actions share it. Claims, leases and review attestations survive Worker eviction and deployment. The Map registry remains a fixture for isolated state-machine tests. Items are stored whole as JSON. The work-claims state machine validates every item it reads (workOf), so a row is never trusted without passing through it first.

**Exports:** `WORK_CLAIM_ROW_KIND`, `createDurableWorkClaimRegistry`, `workClaimSchema`

**Callers/importers (git grep HEAD):** `cloudflare/public-work-claims.check.mjs`, `scripts/candidate-runtime-fixture.mjs`, `scripts/reachability.mjs`, `scripts/runtime-package.mjs`, `server/persisted-row.mjs`, `server/store.mjs`, `tests/chaos/work-claim-chaos-scaffold.mjs`, `tests/claim-pr-sync-room-scoping.test.js`, `tests/persisted-row.test.js`, `tests/public-work-claim-fence.test.js`
