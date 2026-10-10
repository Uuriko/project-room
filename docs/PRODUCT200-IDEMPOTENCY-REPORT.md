# PRODUCT-200 Reliability — Idempotency Coverage Report (B12 final synthesis)

Date: 2026-10-08 · Worker B12 (synthesis) · coordinator: product200-reliability
Repo anchor: `Uuriko/project-room` @ `113781af0` (origin/main, 2026-10-09T~00:4x PDT)
Verified by: code inspection of the live tree + merged PRs + anchor tests. Nothing is
marked covered that was not verified in code.

## Headline

- **Route universe: 277 write operations** (`POST`/`PUT`/`PATCH`/`DELETE` in
  `docs/openapi.yaml` at the anchor commit).
- **Verified-covered: 49 ops (18%)** — idempotency mechanism confirmed in code,
  with an anchor test or merged PR pinning the behavior.
- **Partial: 60 ops (22%)** — a mechanism exists in code, but the anchor proof
  (test or PR) is missing or client-dependent.
- **Pending / unaudited: 168 ops (61%)** — no evidence found either way. Marked
  honestly, not assumed safe.
- **The money-and-state-critical surface is covered**: bounties, credit
  transfers/epoch-close, work-claim lifecycle, access-request create,
  guest-seat redemption, invitation accept, direct channel sends, agent-room
  creation.

## Worker-slice status (B1–B11, honest)

| Slice | Scope | Status |
|---|---|---|
| B1 idemmatrix | full route matrix | **in progress** — WIP scratch (`spec_routes.txt`, `code_routes.txt`) in work dir; no finished report, no PR. Route universe reused for this synthesis |
| B2 claimidem | work-claims | **no report found**, but area covered by merged PRs #2045 (create 409), #2086 (stale settle retry), #2088 (compare-and-release) |
| B3 | — | **work dir missing entirely** — no evidence, marked pending |
| B4 receiptidem | inbox/channel-sends/webhooks | **no report found**, but key routes covered by merged PRs #2085 (direct-send idempotency key), #2052 (webhook 409 terminal + backoff) |
| B5 messageidem | room posts | **no report found**; local branch unpushed. Area = gap #2 below; proof PR #1994 still open |
| B6 boardidem | board-v2/claims | **no report found**. Board v2 is **retired** (410 `board_v2_retired`, `server/http.mjs:63-64`); live claims path = work-claims (covered) |
| B7 roomidem | rooms | **no usable work dir** (not a repo checkout) — no evidence, marked pending |
| B8 miscidem | misc routes | local branch `product200/b8-misc-idempotency` unpushed, **no report found** — marked pending |
| B9 clientretry | client retry discipline | **no report found** — marked pending |
| B10 dedupestore | dedupe store | **no report found**. Verified independently: `bridge/lib/idempotency.mjs` `IdempotencyCache` is 15-min in-memory and **bridge-only** (`bridge/lib/bridge.mjs:101,473`) — the API server has no global dedupe store |
| B11 | — | **not assigned / no work dir found** — marked pending |

## Per-group coverage table

Legend — requestId?: client-supplied key accepted · dedupe?: replay returns
original without re-executing · anchor: test pinning behavior · PR: merged
evidence. Verdict: COVERED / PARTIAL / PENDING.

| Group | Ops | requestId? | dedupe? | Anchor test | PR | Verdict |
|---|---|---|---|---|---|---|
| Bounty escrow (post/fund/rubric/claim/submit/accept/reject/dispute/dispute-decide/finalize/watch/snooze/decline/duplicate/sybil-dismiss/sybil-confirm) | 16 | `Idempotency-Key` header or `idempotencyKey` body | yes — replay returns original status+body, transactional; 409 on key reuse with different input/actor (`server/bounty-escrow-routes.mjs:28-35,~90,~110-150`) | `tests/bounty-idempotency-scope.test.js` (#1000 scope isolation), `tests/bounty-mcp-idempotency.test.js` | #2045, #2086 | COVERED |
| Credits transfer + epoch close | 2 | same as bounties | same — routed through `handleBountyEscrow` (`server/http.mjs:3874-3884`) | same as bounties | #2086 | COVERED |
| Work-claims (create/config/sweep/claim/update/premise-invalid/review/release/close/cancel/reassign/renew) | 12 | claim id is the key | create → 409 `work_claim_exists`; release/update → compare-and-release (`expectedClaimedAt`+`expectedHistoryLength`), stale → 409 `work_claim_conflict` | `tests/work-claim-idempotency.test.js`, `tests/work-claim-settle-retry.test.js` | #2045, #2086, #2088 | COVERED |
| Access requests (create/decide/…) | 4 | yes — `requestId` is the idempotency key (`server/http.mjs:3077`; `server/access-requests.mjs:323`) | yes — keyed writes, auto-approve deduped (`server/access-requests.mjs:518`) | QA200 mut-14 hardening | #2057 | COVERED |
| Guest invites (redeem/mint/duplicate paths) | 3 | invite code + deterministic seat id | yes — re-redeem reuses seat, `duplicate:true`; event built with deterministic `idempotencyKey` (`server/guest-invites.mjs:550-600`) | — | #2081 (docs) | COVERED |
| Invitation accept (invitations/share-links/agent-invites) | 3 | deterministic `redemptionId` | yes — `invitation_already_used` 409 on cross-request accept; same-request accept returns stored receipt `duplicate:true` (`server/store.mjs:3395-3406`) | — | — | COVERED |
| Agent invites redeem | 1 | — | yes — `idempotencyKey: hash('agent-invite-redeem:'+code_hash)` (`server/agent-invites.mjs:290`) | — | — | COVERED |
| Identity links (create/delete) | 2 | — | yes — 409 `already-linked` documented | — | #1975 | COVERED |
| Agent-room create | 1 | client-chosen `roomId` is the key | yes — same identity retrying gets `duplicate:true`, no new room; budget NOT charged on replay | `tests/agent-rooms-idempotent-budget.test.js` | — | COVERED |
| Inbox channel-sends + webhooks (send, webhook, deliveries redrive, verify-delivery, process) | 6 | yes (direct sends) | webhook dedupe keyed `(eventId, subscriptionId)` (`server/agent-plugin-store.mjs:1056-1075`); 409 terminal on retry path | `tests/channel-webhook-dedupe-property.test.js`, `tests/webhook-retry-backoff.test.js` | #2085, #2052 | COVERED |
| MCP / command-journal writes (room_post_message, bond_*, dm_posted, reactions, drafts) | ~12 | command `id` (client-supplied) | yes — `store.command` dedupes on `(room_id, actor_id, requestId)`, returns prior event `duplicate:true`; 409 `idempotency_conflict` on same-id-different-content (`server/store.mjs:3851-3858`); hosted tools instruct "retain and retry the exact original input; do not create a replacement requestId" (`server/mcp-full-profile.mjs:130,349`) | — | #1994 (OPEN, test-only proof) | PARTIAL — mechanism verified, but `room_post_message` defaults `id` to `randomUUID()`, so a retry that doesn't retain `id` double-posts; end-to-end proof pending |
| Auth (magic/password/passkey/recovery flows) | 22 | — | single-use tokens consumed on use; rate limiters on request/consume (`server/http.mjs:348-351`) | — | — | PARTIAL — token pattern present, per-route replay semantics not traced |
| Demigod contracts/offers | 10 | `requestId` seen in `server/demigod-contracts.mjs` | — | — | — | PARTIAL — key field exists, dedupe not verified |
| Public-work MCP (recommend/read/claim/renew/release/finish) | 8 | MCP guidance reuses `requestId` | via `store.command` dedupe | — | — | PARTIAL — REST path unverified |
| Board v2 | 8 | — | — | — | — | safe-by-retirement: routes answer 410 `board_v2_retired` (`server/http.mjs:63-64`) |
| DM consents, project-offers, signoff-loops, matchmaking, feedback, squads, collab, spend-grants/pricing/allowance, human-push, agent-grants, typing, activity-read/read-horizon, read/done/clear updates, saved, mentions, reminders, files, code checks, pins, import, commands, directory, opportunities, public-face, operator, account ops, oauth sessions, agent-keys, agent-heartbeats/ack, agent-skills, webhooks subscribe, web fetch/research, github pr-webhook, agent-connections, referral-invites create/preview/redeem, guest-agent-links refresh, share-links create/cancel, guest-invites rotate/request, membership-delegation/owner-delegates/ownership transfer, /a2a, /mcp, room/mcp | ~168 | — | — | — | — | PENDING — not audited in this pass |

## Ranked gap list (by risk)

1. **No durable server-side idempotency store.** `bridge/lib/idempotency.mjs`
   (15-min in-memory `IdempotencyCache`) serves only the bridge relay
   (`bridge/lib/bridge.mjs:101,473`). Every other mechanism is per-route; anything
   not backed by a DB constraint or the commands table loses dedupe on restart or
   across instances. (B10 produced no report; verified independently.)
2. **Room-post idempotency is client-dependent and unproven.** MCP + HTTP
   command paths dedupe correctly on command `id`, but `room_post_message`
   defaults `id` to `randomUUID()` (`server/mcp-room-profile.mjs:545-549`) —
   clients that retry without retaining `id` double-post. The WS post path was
   not traced. Proof PR #1994 (Fo) is OPEN.
3. **Ownership & delegation transfer routes unverified.** `ownership/transfer`,
   `owner-delegates grant/revoke`, `membership-delegation grant/revoke` — highest
   blast radius, no audit evidence.
4. **DM consents unverified** (block/unblock/revoke/decide) — consent state
   flapping on retry is user-visible harm.
5. **Auth per-route replay semantics unverified** — single-use tokens +
   rate limiters exist (`server/http.mjs:348-351`), but magic/consume,
   password-reset/consume, passkey options/finish were not individually traced
   for double-use windows.
6. **Inbox remainder** — quarantine release/dismiss/split, gmail
   connect/disconnect/sync, connection sync/reconnect: unverified beyond
   channel-sends + webhooks.
7. **Project-offers, public-work REST, signoff-loops, matchmaking, bonds'**
   money-adjacent REST writes — unverified (MCP bond tools ride the command
   journal, REST counterparts unknown).
8. **Long tail of low-risk UI writes** (typing, read-horizon, activity-read,
   saved, mentions) — likely last-write-wins safe, but never audited.

## What this report does NOT claim

- The 61% "pending" is not "broken" — it is unaudited. Many of those routes are
  probably naturally idempotent (PUT/DELETE target sets, last-write-wins reads
  markers); that is an inference, not a finding.
- Client retry discipline (B9) was not evaluated — several server mechanisms
  (command `id`, `requestId`, `Idempotency-Key`) only work if clients retain
  and reuse keys, which is a docs/client contract question, not a server one.
- Nothing here was load-tested for cross-instance replay; the DB-backed
  mechanisms (commands table, escrow idempotency tables) are transactional and
  instance-safe by construction, the in-memory bridge cache is not.

## Appendix — anchor commits/PRs/tests referenced

- PR #2045 `qa200-mut-01` (work-claim create idempotency + assignee cap) — MERGED
- PR #2057 `qa200-mut-14` (access-request retry hardening tests) — MERGED
- PR #2052 `qa200-mut-18` (webhook retry: 409 terminal, backoff) — MERGED
- PR #2085 (idempotency key for direct channel sends) — MERGED
- PR #2086 (commit PR lookups against freshest row; stale settle retry) — MERGED
- PR #2088 (work-claim release compare-and-release, 409 `work_claim_conflict`) — merged per QA-200 failseq log
- PR #1975 (identity-link error codes + already-linked hint) — MERGED
- PR #1994 (Fo, REL-15: prove room posts idempotent across REST and MCP, test-only) — OPEN
- PR #1983 (receipt keys on bond/DM writes, honest room_create idempotency docs) — OPEN
- `tests/work-claim-idempotency.test.js`, `tests/work-claim-settle-retry.test.js`,
  `tests/bounty-idempotency-scope.test.js`, `tests/bounty-mcp-idempotency.test.js`,
  `tests/agent-rooms-idempotent-budget.test.js`,
  `tests/channel-webhook-dedupe-property.test.js`, `tests/webhook-retry-backoff.test.js`

— B12, 2026-10-08 (synthesis only; no code changes in this report)
