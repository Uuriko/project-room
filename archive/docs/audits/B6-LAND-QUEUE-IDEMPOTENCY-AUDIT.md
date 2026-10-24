# B6 — Idempotency audit: land-queue + board mutating routes

Worker: product200-b6-boardidem · 2026-10-08/09 · branch `jill/product200-b6-land-queue-requestid`
Scope: `server/land-queue.mjs` (POST add_land_item / remove_land_item / report_tip),
the work-claims board, board v2. A9 owns board-writes-emit-zero-events (events);
this audit is IDEMPOTENCY only.

## What B1–B12 already covered (no duplication)

- B12 synthesis PR #2152 (`docs/PRODUCT200-IDEMPOTENCY-REPORT.md`): the
  B1–B11 inventory has **zero mentions of land_queue** — the three land-queue
  mutating routes were never audited. Genuine gap.
- Work-claims board (create/config/sweep/claim/update/premise-invalid/review/
  release/close/cancel/reassign/renew): B2 COVERED via #2045 (create 409
  `work_claim_exists`), #2086 (stale settle retry), #2088 (compare-and-release,
  409 `work_claim_conflict`). Verified the 12 route regexes still exist in
  `server/http.mjs:3459-3477` on origin/main. Not re-audited.
- Board v2: retired — every `/board/v2/*` route answers 410 `board_v2_retired`
  (`server/http.mjs:3854`). Safe by retirement; nothing to do.
- No open or merged PR touches land-queue idempotency (gh search:
  `land_queue`, `requestId`, `idempotency` — nothing overlapping).

## Route-by-route findings

### 1. POST /api/rooms/:roomId/add_land_item — GAP (no requestId)

- `requestId` support: **none**. `server/http.mjs:3280` whitelists body keys
  with `exact(data, ["repo","prNumber"])` (+`claimantMemberId`); a
  client-supplied `requestId` is rejected 422 `invalid_land_item`.
  `LandQueue.add()` ignores the field entirely.
- Retry behavior today: natural-key dedupe via
  `UNIQUE(room_id, repo, pr_number)` — a sequential retry hits the `existing`
  branch and returns the item (200, `duplicate:true`). Convergent, but:
  - two *concurrent* adds of the same (repo, pr) both pass the `existing`
    check and the loser eats a raw `SQLITE_CONSTRAINT` 500 (no graceful
    dedupe; the check and INSERT are not guarded).
  - no replay receipt: the second response is a fresh `#refreshRow` (new
    GitHub fetch, `updated_at` bump), not the original response.
  - a retry after a 404 `pr_not_found` re-creates the row each time (add
    deletes the row on `pr_not_found` before rethrowing).

### 2. POST /api/rooms/:roomId/remove_land_item — GAP, headline (not retry-safe)

- `requestId` support: **none**. `exact(data, ["itemId"])` 422s any extra key.
- Retry behavior today: first call → 200 `{removed:true}`; a retry after a
  lost/timeout response → **404 `land_item_not_found`**. The client cannot
  distinguish "the delete never happened" from "the delete happened and this
  is a duplicate" — the textbook non-idempotent delete. A safe retry is
  impossible without a key.
- (Events: the delete emits a `work_claim.updated` "deleted" receipt inside
  the delete transaction; the 404 retry path emits nothing, so no double-emit
  — event shape is A9's anchor, not changed here.)

### 3. POST /api/rooms/:roomId/report_tip — GAP (no requestId)

- `requestId` support: **none**. Strict key list
  `["itemId","sourceRevision","buildId"]` 422s extras.
- Retry behavior today: an identical retry converges — `tipTransition`
  yields `changed:[]` so no second `land.updated` event fires; the row UPDATE
  is value-identical (only `updated_at` bumps). Safe in the identical case,
  but there is no replay of the *original* response (`changed:["tip"]` is
  lost), and cross-request races are silent last-writer-wins with no conflict
  signal.

## Fix (one PR, this branch)

Accept optional `requestId` on all three routes (REST + hosted MCP tools +
`docs/openapi.yaml`), backed by a `land_queue_idempotency` table keyed on
`(room_id, request_id)`:

- Pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (same as access-requests'
  `REQUEST_ID_PATTERN`); bad shape → 422 (`invalid_land_item` /
  `invalid_land_tip`).
- Same (room, requestId, op, actor, input-hash) → replay the stored response
  byte-identical (bounty-escrow convention: replay returns original).
- Same requestId, different op/actor/input → 409 `idempotency_conflict`
  (store.command / access-requests / bounty convention).
- Same requestId while a first call is still in flight → 409
  `idempotency_conflict` ("already in flight").
- Only 2xx outcomes are recorded; failures delete the placeholder so a retry
  re-executes fresh (never replays a stale 503 `github_unconfigured`).
- MCP: optional `requestId` arg on the three tools, validated and passed
  through to `LandQueue`.
- OpenAPI: `requestId` added to the three requestBody schemas with 409
  `idempotency_conflict` documented.

Fail-first tests: `tests/land-queue-idempotency.test.js`
(remove-retry replays instead of 404; add-retry replays stored body with no
new GitHub fetch; tip-retry replays `changed:["tip"]` with no second event;
conflict/mismatch → 409; bad shape → 422; REST layer accepts the key).

## Out of scope / not duplicated

- Work-claims board mutations: B2's, COVERED.
- Board v2: retired (410).
- board-writes-emit-zero-events: A9's anchor; land-queue write events
  (`land.updated`, delete receipts) intentionally untouched.
- Durable cross-route idempotency store (B12 gap #1): noted, not built here;
  this PR is per-route keyed writes, the established pattern.
