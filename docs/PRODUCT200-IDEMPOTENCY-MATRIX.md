# IDEMPOTENCY MATRIX — PRODUCT-200 Reliability worker B1/50 (route matrix)

**Worker:** B1/50 (respawn) · coordinator: product200-reliability · claim: product200-reliability (registered)
**Repo anchor:** `Uuriko/project-room` @ `be7ce3b17` (origin/main, fetched 2026-10-08 ~21:xx PDT)
**Method:** read-only code audit of the live tree. Every mutating route was located in
`server/http.mjs` (the room funnel ~L3350–L5010 + top-level identity/invite/oauth blocks
~L950–L3300), its handler module was read for requestId/idempotencyKey acceptance, a
dedup store/key, replay semantics, and transaction boundaries. Cross-checked against
`~/workspace/project-room-qa/qa200-failseq/RANKED-FINDINGS.md` and
`~/workspace/project-room-qa/qa200-invariants/RESULTS.md`. No code changed, no fixes — audit only.

**Scope note:** the work-claim **close/cancel** route exists in `server/work-claim-routes.mjs`
but is not reachable over REST from `server/http.mjs` — it is MCP-only
(`room_close_work_claim` in `server/mcp-full-profile.mjs`). Board v2 is retired (410).
The route-table dispatcher (`server/routes/table.mjs`) is GET-only; all mutating routes
live in the legacy http.mjs chain + family handlers.

**How to read the columns:**
- **Key?** — does the write accept a client idempotency key (`requestId`, `idempotencyKey`,
  or `Idempotency-Key` header), or is a natural key (client-chosen `id`, single-use code)
  the implied dedup key?
- **Dedup?** — on replay with the same key: does the server avoid re-executing (store,
  key/window)?
- **Replay→prior?** — does the retry return the ORIGINAL result (not just avoid the write)?
- **Atomic?** — writes committed in one transaction / crash-safe, or partial states possible?
- **Risk** — P0: replay destroys committed work or double-moves value · P1: replay creates
  duplicate artifacts corrupting counts/receipts, or the recovery path is missing ·
  P2: no key but idempotent-by-design (set semantics, keyed upserts, single-use tokens),
  benign duplicates, or contract caveats.

## Family summary (read this first)

| Family | Routes | Key support | Verdict |
|---|---|---|---|
| Bounty escrow + credit ledger (`handleBountyEscrow`) | 19 | `idempotencyKey` body or `Idempotency-Key` header, scoped `(caller, route, bounty, key)` + request-hash | COVERED — replay returns original status+body in-transaction; 409 `idempotency_key_reused` on key reuse with different input; legacy unscoped rows refused (`bounty-escrow-routes.mjs:90-150`, `bounty-escrow.mjs:3018-3055`) |
| Public-work REST (`claim/renew/release/finish`, reviews `decide/verify`, follow-up, project-offers `create/publish/withdraw/claims`) | 11 | `requestId` REQUIRED | COVERED — `(room_id, actor_id, request_id)` tables; replay returns stored outcome; 409 `request_id_reused` on different input; revision/generation guards (`stale_review`, `stale_review_receipt`, `review_final`); release requires `requestId`+`expectedTermsVersion` |
| Message/DM/pins commands (`store.command`) | 3 | command `id` REQUIRED (`validateCommand`) | COVERED — `(room_id, actor_id, id)` lookup; same id+content → 200 `duplicate:true` with prior event; same id+different content → 409 `idempotency_conflict`; DM event INSERT + `sealDm` atomic (`store.mjs:4527-4528`); pins accept optional `requestId` → command id (`server/pins.mjs:47-86`) |
| Room work-claims (`handleWorkClaims`) | 10 | NO `requestId` anywhere in family | MIXED — create uses client `id` (409 `work_claim_exists`); claim/release/reassign/renew/close-calc are state-machine guarded; **release + update now round-bound** (`expectedClaimedAt`+`expectedHistoryLength`, #2078 opt-in / #2088 required — stale → 409 `work_claim_conflict`); **update has no replay dedup** (see risk #1) |
| Channel/inbox sync (`routes/inbox.mjs`) | 2 | `requestId` REQUIRED | COVERED — duplicate replay returns prior receipt |
| Access requests create | 1 | `requestId` = caller idempotency key | COVERED — retry returns original request |
| Access decide | 1 | — | COVERED-ish — double decide → 409 `already_decided` |
| Updates / reminders / attention / wake-queue / work-sessions / agent-connections / share-links / guest links+invites / invitations / handoff envelopes | 15 | `requestId` REQUIRED or optional | COVERED — fingerprint dedup, `duplicate:true` replay |
| DM consents / saved / mutes / mention-ack / toggles / verification-policy / directory / public-face | ~20 | — | IDEMPOTENT-BY-DESIGN — set semantics or per-pair dedup; safe on retry |
| Feedback submit/triage/appeal/outcome | 5 | NO key | PARTIAL — content-based dedup (endpoint+response), retries absorbed as `duplicate` outcome at no Mark cost, but each retry mints a new item id and inflates cluster counts |
| Collab notes/assignments/locks/approvals/routing/handoffs (non-envelope) | 16 | NO key (envelopes only) | PARTIAL — lock-acquire returns `duplicate:true` for same holder; others append ops; notes/approvals duplicate on retry |
| Matchmaking declare/offer/decision/answer | 5 | client `decisionId`/keyed upserts | IDEMPOTENT-BY-DESIGN mostly — upserts by seekerId/openingId; decision-open retry with a NEW decisionId duplicates |
| Identity mint | 1 | NO key (`exact()` shape rejects extras) | P2 — retry after timeout mints a second identity; rate-limited |
| Invite redeem (`agent-invites`, `guest-invites`, `share-links`, `referral-invites`) | 4 | code = credential | COVERED-by-code (single-use, 409 on re-redeem) — **but** redeem→timeout→retry strands membership with no recovery path (G1, risk #2) |
| Session/oauth/recovery-codes | ~10 | — | P2 — single-use tokens, session mgmt |
| Operator/admin imports | ~5 | — | P2 — owner-only, import rejects duplicate event ids |

**Totals: ~139 mutating route-methods audited; ~38 with NO requestId/idempotencyKey support.**
Of the no-key routes, ~24 are idempotent-by-design (set semantics, keyed upserts, single-use
tokens), ~10 are PARTIAL (mechanism exists but client-dependent or incomplete), and
**10 carry real residual risk** — ranked below.

## Full route matrix

### A. Room work-claims family (`POST /api/rooms/{id}/work-claims…`, `server/work-claim-routes.mjs`)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/work-claims` (create) | NO — client `id` is the implied key | 409 `work_claim_exists` on same id | NO (409, not prior) | YES (single tx) | P1 | Client id is the dedup key but documented nowhere as a retry contract; retry with a NEW id creates a duplicate claim |
| POST `/{id}/claim` | NO | state-guard: re-claim same holder → 409 `work_claim_conflict` | NO (409) | YES | P2 | Round race fixed by release binding; claim itself still has no round token but 409 names the real holder (#2084) |
| POST `/{id}/update` | NO | NO — `withHistory()` unconditionally appends (`work-claims.mjs:457-464`) | NO | YES | **P1** | #2078 opt-in `expectedClaimedAt`/`expectedHistoryLength` guards concurrency, NOT dedup. Opt-in `requestId` dedup exists: a `requestId` that already landed on this claim replays the stored outcome without appending (`work-claims.mjs:731-735`, PRODUCT-200 A4). Blind retry of a timed-out update with NO `requestId` → duplicate history entry, inflates `historyOmitted` permanently. QA-200 s7-r2 BUG-2, code-verified, still open on main |
| POST `/{id}/review` (verdict) | NO | YES — repeat identical verdict returns existing item, no commit | YES (200, existing) | YES | P2 | Note-path: SEC-2 repeat note replaces stored note without a history entry — idempotent |
| POST `/{id}/release` | NO — but REQUIRES `expectedClaimedAt`+`expectedHistoryLength` (#2088) | stale round → 409 `work_claim_conflict` + read-back hint | NO (409) | YES | P2 | **E5 FIXED on main.** Release binds the claim round; replay of a stale release no longer destroys the fresh claim |
| POST `/{id}/reassign` | YES — requires `expectedClaimedAt`+`expectedHistoryLength` (#2262) | stale round → 409 `work_claim_conflict` | NO (409) | YES | P2 | Round-bound like release; target must be a live room member (422 `work_reassign_unknown_member`) |
| POST `/{id}/renew` | NO | lease math guard | NO | YES | P2 | Idempotent-by-lease: renewing a fresh lease is a no-op-ish extend |
| POST `/{id}/close`\|`/cancel` | NO (`{reason?}`) | terminal state guard | NO | YES | P2 | **REST-unreachable** (no http.mjs route) — MCP `room_close_work_claim` only |
| POST `/work-claims/sweep` (+ GET list runs `sweepRoom`/`closeLiveClaims`) | n/a | sweep is self-limiting | n/a | YES | P2 | Read-path write: `GET /work-claims` auto-releases expired leases (`work-claim-routes.mjs:385-403`; inv-b23). Snapshot reads commit `state_changed` events |
| POST `/work-claims/config` | NO (`{maxMemberOpenClaims}`) | set semantics (owner) | n/a | YES | P2 | Plain assignment |

### B. Bounty escrow + credit ledger (`POST /api/rooms/{id}/bounties…|credits…`, `server/bounty-escrow-routes.mjs`)

All 19 write routes (`create post`, `fund`, `decline`, `snooze`, `duplicate`, `watch`, `claim`,
`submit`, `accept`, `reject`, `dispute`, `dispute-decide`, `finalize`, `rubric`,
`sybil-dismiss`, `sybil-confirm`, `credits/transfer`, `credits/epoch/close`) accept
`idempotencyKey` in the body or the `Idempotency-Key` header (`idemKeyOf`, :90-95),
scoped `(callerLane, route, bountyId, key)` with a request-hash (`bounty-escrow.mjs:3037`).
Replay returns the original status+body inside the same transaction; key reuse with
different input or a different caller → 409 (`idempotency_key_reused`,
`idempotency_scope_required`); legacy unscoped `(room, key)` rows are refused outright
(`idempotency_actor_mismatch`). **All COVERED, no key → P2 caveat:** without a key the
call executes fresh, so a keyless retry re-executes — the dedup contract is opt-in.

### C. Public-work REST (`/api/public-work/...`, `/api/project-offers/...`)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/public-work/tasks/{id}/{claim\|renew\|release\|finish}` | YES (`requestId` required) | `(offer_id, actor_id, request_id)` table; `public_work_requests` | YES | YES | OK | release requires `requestId`+`expectedTermsVersion` — the contract the room board lacked before #2088 |
| POST `/public-work/receipts/{id}/review` (decide/verify) | YES (`requestId` required) | `public_work_review_requests` | YES | YES | OK | 409 `request_id_reused` on different input; `stale_review`/`review_final` revision guards |
| POST `/public-work/receipts/{id}/follow-up` | YES (`requestId` required) | `public_work_successor_requests` | YES | YES | OK | Derived sub-requestIds for create/publish/enable (`public-work-successors.mjs:76-85`) |
| POST `/project-offers` create/publish/withdraw/claims | YES (`requestId`) | `offer_requests` table | YES | YES | OK | Mirror of the public-work pattern |

### D. Message/DM/commands surface (`POST /api/rooms/{id}/commands`, `server/store.mjs:4569-4600`)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/commands` (message.posted, dm.posted, reactions, pins, spend/allowance/pricing via command) | YES — command `id` REQUIRED | `(room_id, actor_id, id)` + content fingerprint | YES — 200 `duplicate:true` + prior event | YES | OK* | *Client must supply a stable id across retries; `pins` accepts optional `requestId` as the command id. Same id+different content → 409 `idempotency_conflict`. DMs: two-layer (command id + messageId reuse → 409), event INSERT + `sealDm` atomic (`store.mjs:4527-4528`). Spend allowance/pricing ride this path (`spend-allowance.mjs:124`, `spend-pricing.mjs:63`) |
| POST `/pins` | optional `requestId` | → command dedup when supplied | YES when supplied | YES | P2 | Without `requestId` a fresh random command id is minted per call; the "already in state" early-return (no event) absorbs most pin replays anyway |

### E. Inbox/collab family (`/api/rooms/{id}/collab/...`, `server/inbox-collab-routes.mjs`)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/collab/assignments` | NO (`{threadId, assignee, force?}`) | overwrite per thread | NO | YES | P2 | Op-log; re-assign overwrites, no duplicate rows |
| POST `/collab/assignments/{id}/release` | NO | release is terminal | NO | YES | P2 | Idempotent release |
| POST `/collab/notes` | NO (`{threadId, body, tag?}`) | NO — append-only | NO | YES | **P1** | Retry after timeout → duplicate note rows |
| POST `/collab/draft-locks/acquire` | NO | YES — `duplicate:true` for same holder+thread | YES (200) | YES | P2 | Holder-scoped dedup without a key |
| POST `/collab/draft-locks/release` | NO (`{lockId}`) | release terminal | NO | YES | P2 | |
| POST `/collab/approvals` (propose draft) | NO | NO — new proposal per call | NO | YES | **P1** | Retry → duplicate proposals; no dedup key |
| POST `/collab/approvals/{id}/decide` | NO | op-log; re-decide appends | NO | YES | P1 | Needs a guard check — a retried `approve` appends a second decide op (verify: `decideApproval`, `inbox-collab-store.mjs:551`) |
| POST `/collab/approvals/{id}/resubmit` | NO | appends | NO | YES | P2 | |
| POST `/collab/routing`, `/routing/resolve`, `/routing/policy`, `/routing/mentions` | NO | op/set semantics | NO | YES | P2 | |
| POST `/collab/handoffs`, `/handoffs/{id}/transition`, `/envelopes` | YES (`requestId` on create) | `work-handoff.mjs` envelope dedup → `duplicate:true` | YES | YES | OK | Only collab route with a key |
| POST `/collab/envelopes/{id}/transition`, `/envelopes/sweep` | NO | op-log / sweep | NO | YES | P2 | |

### F. Matchmaking (`/api/rooms/{id}/matchmaking/...`, `server/matchmaking-routes.mjs`)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/matchmaking/seeker` (declare) | NO — keyed by authenticated seekerId | upsert by seekerId | YES (overwrite) | YES | P2 | Same caller re-declaring overwrites |
| POST `/matchmaking/openings` (offer) | NO — keyed by openingId | upsert by work_id | YES (overwrite) | YES | P2 | |
| POST `/matchmaking/match` | — | pure computation, no mutation | n/a | n/a | P2 | |
| POST `/matchmaking/decisions` (open) | client `decisionId` REQUIRED | overwrite by decisionId | YES (overwrite) | YES | P2 | Retry with a NEW decisionId → duplicate decisions (client-key contract) |
| POST `/matchmaking/decisions/{id}/answer` | NO | overwrite `answers[decisionId]` | YES (overwrite) | YES | P2 | Courier+answerer checks; re-answer overwrites |

### G. Feedback (`/api/rooms/{id}/feedback/...`, `server/feedback-store.mjs`)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/feedback` (submit) | NO | content dedupKey (endpoint+response) → outcome `duplicate`, cost-free | NO (new item id each time) | YES | P2 | Retries safe on cost but inflate cluster counts and mint new ids |
| POST `/{id}/triage\|appeal\|appeal/decision\|outcome` | NO | state-transition guards | NO | YES | P2 | Mark-staked economy; transitions are forward-only |

### H. DM consents + peer DMs (`server/dm-consents.mjs`, `server/bonds.mjs`)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/dm-consents` (request) | NO — keyed by (room, requester, target) | existing pending row returned; approved → 409 `dm_already_approved` | YES (same row) | YES | P2 | |
| POST `/dm-consents/{id}/decide\|block\|revoke\|unblock` | NO | set semantics | n/a | YES | P2 | |
| DM send (via `/commands` dm.posted) | YES (command id) | two-layer: command id + messageId reuse → 409 | YES | YES | OK | Code-verified by QA-200 inv-b37 |

### I. Keyed misc routes (requestId REQUIRED, dedup store, `duplicate:true` replay)

| Route | Notes |
|---|---|
| POST `/updates/{id}/{read\|done\|clear}` (`server/updates.mjs`) | fingerprint(action,itemId,requestId,expectedBasis); replay returns prior response+`duplicate:true` |
| POST `/reminders` (`server/reminders.mjs`) | requestId dedup, prior response replayed |
| POST `/notifications`-adjacent attention (`server/attention.mjs`) | requestId dedup |
| POST `/agent-pause` (`server/wake-queue.mjs`) | `requestId` REQUIRED; duplicate→200 |
| POST `/work-sessions` (`store.mutateWorkSession`, `store.mjs:3767`) | `requestId` REQUIRED; duplicate→200 |
| POST `/agent-connections` (`server/agent-connections.mjs`) | `requestId` + `expectedRevision` optimistic concurrency; duplicate→200 |
| POST `/guest-agent-links` (`server/guest-agent-links.mjs`) | `idemRecord` (room,keyHash,requestId); duplicate→200 |
| POST `/guest-invites` (room funnel) (`server/guest-invites.mjs`) | `idemRecord`; duplicate→200 |
| POST `/share-links` create (`server/share-links.mjs`) | `requestId`; duplicate→200; cancel is set-semantics |
| POST `/invitations` create (room funnel) (`server/store.mjs:3241`) | `issue_request_id` scoped by issuer; 409 `idempotency_conflict` on reuse with different scope; duplicate→stored receipt |
| POST `/collab/handoffs`, `/collab/envelopes` | requestId → envelope dedup |
| Channel sync POST (`server/routes/inbox.mjs`) | `requestId` REQUIRED; duplicate→200 |
| POST `/api/access-requests` (top-level create) | `requestId` = caller idempotency key; retry returns original request |

### J. Idempotent-by-design, no key needed

| Route | Mechanism |
|---|---|
| POST `/access-requests/{id}/decide` | 409 `already_decided` |
| POST `/activity-read`, `/activity-read-all`, `/read-horizon` | mark-to-point set semantics |
| POST|DELETE `/saved`, DELETE `/saved/{messageId}` | set semantics |
| POST `/mentions/{id}/ack` | idempotent ack (#658) |
| POST `/mentions/settings`, `/thread-mutes`, `/verification-policy` | plain assignment |
| POST `/directory`, `/opportunities`, `/public-face` (toggles) | plain assignment (owner-only) |
| POST `/public-face/rotate` | intentionally non-idempotent (secret rotation) |
| DELETE `/members/{id}` (self-deactivate) | second DELETE fails safe (not member) |
| POST `/delegation/grant\|revoke`, `/owner-delegates/grant\|revoke` | grant upsert / revoke terminal (owner-only) |
| POST `/ownership/transfer` | owner-only; post-transfer the caller is no longer owner so a replay 403s |
| POST `/operator/agents/{id}` (PUT) | admin set (operator) |
| POST `/files`, POST `/files/{id}/commit` | stage dedupes by client `id`; commit is set-semantics |
| POST `/import` | owner-only; duplicate event ids → 422 |
| POST `/spend-allowance` (via command) | optional requestId → command dedup |
| Session/auth top-level: POST `/oauth/token`, `/oauth/revoke`, `/oauth/sessions/revoke-all`, `/api/session`, `/api/auth/agent/*`, `/api/auth/recovery-codes/*`, POST `/join` | single-use tokens / session mgmt |

### K. Top-level identity/invite/join surface (code = credential pattern)

| Route | Key? | Dedup? | Replay→prior? | Atomic? | Risk | Notes |
|---|---|---|---|---|---|---|
| POST `/api/agent-identities` (mint) | NO (`exact()` shape rejects requestId) | NO | NO — new identity per call | YES | **P2** | Retry after timeout → duplicate identities for one human intent; rate-limited (`identity-create:30`); the QA-200 mint-storm showed the 80/day network budget saturates under wave load — no key means no safe client retry at all |
| POST `/api/agent-invites/redeem` | code = credential | single-use code; re-redeem → 409 | NO | YES | **P1** | QA-200 G1: redeem commits the membership burn but the 201 body is lost on timeout → retry gets 409 with NO recovery path. Security-adjacent, deferred to owner, still open |
| POST `/api/guest-invites/redeem`, `/api/share-links/join*`, `/api/referral-invites/redeem` | code = credential | single-use / deterministic seat | partial | YES | P2 | Same timeout-body-loss shape as G1, lower blast radius |
| POST `/api/agent-rooms` (create room) | client `roomId` | `duplicate:true` on same identity+roomId (`tests/agent-rooms-idempotent-budget.test.js`) | YES | YES | OK | |
| POST `/api/access-requests` | YES | covered (see I) | YES | YES | OK | |

## Top-10 ranked risks (WAVE-300 consumption order)

1. **P1 — Work-claim update retry appends duplicate history entries.** `POST /api/rooms/{id}/work-claims/{id}/update` accepts no `requestId`; `withHistory()` (`server/work-claims.mjs:457-464`) unconditionally appends. A blind retry of a timed-out update permanently inflates the history count (and `historyOmitted` after the 200-entry cap). #2078's opt-in `expectedClaimedAt`/`expectedHistoryLength` fixes concurrency, not dedup. QA-200 s7-r2 BUG-2, code-verified, still open on main. Fix shape: per-(claim, requestId) idempotency row, or a byte-identical no-change guard that skips the history stamp.
2. **P1 — Redeem→timeout→retry strands membership (G1).** `POST /api/agent-invites/redeem` commits the membership burn server-side; if the 201 body is lost, the retry gets 409 with no recovery path. QA-200 failseq candidate (medium), deferred to owner — no fix PR. Same body-loss shape applies to the other code-redeem routes.
3. **P1 — Collab notes append-only.** `POST /api/rooms/{id}/collab/notes` has no key; a retried POST after a timeout creates duplicate note rows (`inbox-collab-routes.mjs` notes case).
4. **P1 — Collab approvals duplicate on retry.** `POST /api/rooms/{id}/collab/approvals` (propose draft) has no key; retry creates a second proposal awaiting human review.
5. **P1 — Approval re-decide appends ops.** `POST /api/rooms/{id}/collab/approvals/{id}/decide` has no key and appends a decide op per call (`decideApproval`, `inbox-collab-store.mjs:551`) — a retried `approve` after a lost 200 needs a guard confirming a no-op or 409; verify before fixing.
6. **P2 — Mint retry mints a second identity.** `POST /api/agent-identities` has no key and `exact()`-rejects extras, so a client cannot even supply one. Under wave load this compounds the 80/day rolling budget exhaustion QA-200 measured.
7. **P2 — Bounty/credits idem keys are opt-in.** Without `idempotencyKey` (body) or `Idempotency-Key` (header), a retried fund/transfer executes fresh. The mechanism is excellent; the contract should be pushed in docs/SKILL.md ("always send a key").
8. **P2 — Work-claim create's client-`id` retry contract is undocumented.** Retry with the same `id` → 409 `work_claim_exists` (safe); retry with a new `id` → duplicate claim. SKILL.md should bless "retry with the SAME id".
9. **P2 — Matchmaking decision-open duplicates on new-id retry.** Client `decisionId` is required and overwrites on reuse, but a retry that generates a new id opens a second decision.
10. **P2 — Feedback submit inflates clusters on retry.** No key; content dedup absorbs retries as cost-free `duplicate` outcomes, but each retry mints a new `fb-######` item and bumps `cluster.count`.

## Fixed since QA-200 (verify, don't re-fix)

- **E5 stale-self-retry (was P0) — FIXED on main via #2088 (commit `2e46c7862`).** `POST .../work-claims/{id}/release` now REQUIRES `expectedClaimedAt`+`expectedHistoryLength`; a stale replay → 409 `work_claim_conflict` with a read-back hint instead of destroying the fresh claim round. Verified in code at `server/work-claim-routes.mjs` on `be7ce3b17`.
- **D4/C3 update-side preconditions — merged via #2078.** Opt-in round binding on plain update; does NOT fix retry-dedup (risk #1 above).
- **Claim-conflict hint — merged via #2084.** The old "release it first" advice (which destroyed self-claims on re-claim) is gone.

## Cross-references

- QA-200 failseq ranked findings: `~/workspace/project-room-qa/qa200-failseq/RANKED-FINDINGS.md`
  (E5/D4/G1, B4 asymmetric DM dedup, mint-budget findings)
- QA-200 invariants results: `~/workspace/project-room-qa/qa200-invariants/RESULTS.md`
  (inv-b24 board-events P1, inv-b23 read-path writes, inv-a12 `updateWork` post-done 422 guard,
  inv-a15/b34/b35/b38 Retry-After non-determinism, inv-b37 DM two-layer idempotency)
- Sibling B12 synthesis: `~/workspace/project-room-qa/product200-reliability/IDEMPOTENCY-REPORT.md`
  (group-level coverage; its "COVERED" verdicts for work-claims release/update are now accurate
  on main; its pending/unaudited set overlaps risks #3–#5, #9, #10 above)
- Anchor tests to reuse: `tests/work-claim-idempotency.test.js`, `tests/work-claim-settle-retry.test.js`,
  `tests/bounty-idempotency-scope.test.js`, `tests/bounty-mcp-idempotency.test.js`,
  `tests/agent-rooms-idempotent-budget.test.js`, `tests/pinned-messages.test.js`,
  `tests/pins-dm-visibility.test.js`

## Honest gaps

- Live replay verification was impossible: this is a read-only code audit; no writes were
  executed against production. The QA-200 write-wave slices largely could not run either
  (mint-budget exhaustion), so several rows rest on code reading + the fail-first tests
  named above. WAVE-300 crews should run the staged repro scripts
  (`~/workspace/project-room-qa/qa200-failseq/inv-s7/scenario-a4-r2.sh`,
  `scenario-a3-r2.sh`) against a membership-bearing identity before closing risks #1–#5.
- Collab op-log routes (assignments/locks/approvals/routing/handoffs) were audited at the
  route-handler level; the CRDT op-merge semantics in `server/inbox-collab-store.mjs` were
  not fully traced — risk #5 is flagged "verify" for that reason.
- The `bridge/lib/idempotency.mjs` `IdempotencyCache` is bridge-only (per B12); the API
  server has no global dedupe store — every idempotency guarantee is per-family.
- MCP room tools inherit the REST surface's guarantees (same store functions); the MCP
  layer itself adds no idempotency. Hosted-tool guidance ("retain and retry the exact
  original input") covers only tools that route through `store.command`.
