# http.mjs lines 2501–3750 — module notes (WAVE-400 code archaeology)

## Purpose

This span is the middle of the monolithic HTTP request handler in `server/http.mjs`.
It wires three things: (1) top-level open/auth routes for identity, invites, and
sessions (`POST /join`, `/api/agent-identities`, `/api/session`, `/api/agent-invites/*`,
`/api/referral-invites/*`, `/api/access-requests*`, `/api/agent-rooms`, `/api/needs-me`,
`/api/updates`, `/api/web/fetch`, `/api/web/research`, `/api/claims/validate`,
`/api/guest-invites/rotate`, `/api/share-links/*`, `/api/invitations/*`); (2) the
room-scoped route **funnel** preamble (all `/api/rooms/:roomId/*` regex matchers,
the 404 guard, roomId extraction, shared credential/fence/rate-limit/API-key-scope
checks); and (3) the first two room-family dispatches (inbox-collab, work-claims;
the rest — matchmaking, feedback, bounties, credits, board-v2 — continue past 3750).

Everything is inline `if (url.pathname === ...)` / regex-exec branches inside one
request handler; there are no exported functions in this span.

## Route registrations / handlers (one-line each)

Top-level (open or identity-scoped) routes:
- `POST /api/guest-invites/rotate` (2513): rotates a guest credential; bearer guest
  token + optional session binding fence.
- `POST /api/share-links/preview` (2523): read-only invite-link preview; no auth.
- `POST /api/share-links/join-agent` (2530) / 405 twin (2559): agent joins via share
  link with a global identity secret; returns self-describing `next[]` guidance
  (Burs-IA A1 pattern); jev-shadow admission journals the join.
- `POST /api/share-links/join` (2562): browser join via share link; account session
  + write fence; revokes the old room token when supplied.
- `POST /api/invitations/preview` (2576): read-only invitation preview; no auth.
- `POST /api/invitations/accept` (2583): accepts an invitation into an account
  session; idempotent via `redemptionId` + `expectedRevision`.
- `POST /api/session` (2594): access-key login; mints a room session cookie.
- `POST /api/auth/agent/rooms` (2607): agent browser sign-in step 1 — identity
  secret verifies, lists linked rooms.
- `POST /api/auth/agent/session` (2620): agent browser sign-in step 2 — mints a
  room-scoped browser session for the chosen room.
- `POST /join`, `/room/join`, `/api/join` (2643): the one-URL machine door — mints
  an identity + personal first room (atomic via `store.transaction`), or redeems an
  invite code; sets the session cookie so the browser lands inside the room.
- `GET /join`, `/join/:code`, `/room/join` twins (2736): join-page HTML; permissive
  code segment so malformed codes render the error screen, not the generic 404.
- `/api/session` GET/DELETE (2777): GET returns the session view (account or room
  mode via `?room=` / `x-project-room-auth`); DELETE signs out / revokes; 405 else.
- `POST /api/web/fetch` (2801): room-side web fetch; room member only, guest gate
  (`isWebFetchGuest`, #798); typed `WebFetchError` → status/429, never 500.
- `POST /api/web/research` (2839): room-side knowledge router (plan + execute);
  same auth posture as web/fetch; planning free, execution bills research quota.
- `POST /api/claims/validate` (2873): unauthenticated synchronous pre-post
  validation of ```room-claim blocks; pure function of the body, no state.
- `POST /api/agent-identities` + `/api/identity-create` (2893) / 405 twin (2922):
  open identity mint, per-address rate limit + budgets inside `create`; optional
  `proof` and `recoverable` flows.
- `POST /api/agent-invites/redeem` (2933) / 405 twin (2959): unauthenticated invite
  redemption; structured `diagnoseArguments` 422 (names missing/unexpected fields).
- `POST /api/referral-invites/mint` (2966) / 405 twin (2980): owner/can-invite
  member mints a signed bearer referral token; optional numeric `maxDepth`.
- `POST /api/referral-invites/redeem` (2983) / 405 twin (3011): unauthenticated
  redemption; lands stranger at read+chat; optional displayName/proof/bearer attach.
- `POST /api/referral-invites/preview` (3018) / 405 twin (3024): read-only consent
  preview; POST (not GET) so the bearer token never lands in query strings/logs.
- `GET /api/agent-invites/preview` (3030): read-only consent preview keyed by
  `?code=`; unauthenticated, reveals no member/identity data.
- `POST /api/access-requests` (3039) / 405 twin (3097): self-serve join request;
  unauthenticated; structured 422 + self-describing `next`/`nextActions` cold-start
  guidance; `requestId` is the idempotency key.
- `GET/POST /api/agent-rooms` (3104/3108) / 405 twin (3118): identity-secret room
  list / self-serve room creation (caller becomes owner); per-address rate limits.
- `GET/HEAD /api/needs-me` (3122) / 405 twin (3137): cross-room attention rollup
  for one identity secret; rejects room-scoped `rak_` tokens
  (`ROOM_TOKEN_NOT_IDENTITY`).
- `GET/HEAD /api/updates` (3162) / 405 twin (3173): identity-wide updates
  projection (identity secret) or account updates (account session + binding).
- `/api/rooms/:roomId/updates*` (3175): list (GET/HEAD) and mark
  (read/done/clear, POST) with `requestId` + `expectedBasis` concurrency guard
  (JDOT-COH-UPDATES-BASIS).
- `GET /api/access-requests/:requestId` (3203): requester's status poll; requires
  `identityId` query param; returns status + continuation guidance.
- `POST /api/access-requests/:requestId` (3228): requester cancels their own
  request; caller's bearer secret must match the requesting identity.

Room funnel matchers + dispatches (regex declarations 3238–3551; shared funnel
3554–3705; dispatches 3706+):
- `add_land_item / list_land_queue / remove_land_item / report_tip` (3238–3294):
  PR land queue; any member; GitHub-token-missing reads are 503.
- `/api/rooms/:roomId/files*` (3296–3345): stage/list/commit/GET-bytes room
  attachments (same store as MCP file tools).
- `/api/rooms/:roomId/public-work/*` (3347–3629): public contribution review —
  results/inspect (GET/HEAD) and decide/verify/follow-up (POST) with an
  acting-identity re-check inside the transaction; FO-DRIFT-1/2 `auth` selector
  validation; guests denied.
- `/api/rooms/:roomId/project-offers/*` (3353–3661): owner project offers —
  publish/withdraw/claims transitions + create, re-authenticated in-transaction.
- The giant `match` regex (3357) enumerates every funnel subroute literal
  (commands, events, context, stream, …, agent-inbox, activation-pack, orient, …);
  `route` names dispatch later in the file (beyond this span).
- `messages/:messageId/thread` (3360): threaded replies share the room funnel.
- `access-requests/:id/decide` (3361): room-side decision on an access request.
- `membership-delegation/*` (3365–3367), `owner-delegates/*` (3371–3373):
  owner-granted membership administration / owner-authority grants.
- `saved/:messageId` (3375): DELETE unsaves one message.
- `ownership/transfer` (3376): owner appoints a new owner (handler at 4611).
- `dm-consents/*`, `peer-dms/:id` (3378–3383): consent-bound DM decide/block/
  revoke/unblock + peer DM threads (RC-2026-09-19-070 DM privacy).
- `operator/agents/:id` (3384): per-agent autonomy tiers, owner-only.
- `agent-grants*`, `agent-capabilities` (3385–3387): per-agent capability grant
  edges; management owner-or-delegate, agents read own.
- `mentions/settings`, `mentions/:id/ack` (3391–3392): mention lifecycle.
- `members/:memberId` (3394): DELETE self-deactivates own membership only.
- `members/:memberId/card`, `directory/seed` (3395–3396): directory cards.
- `public-face/rotate` (3398): owner-only public-face rotation.
- `collab/*` (3400–3726): inbox-collaboration family (assignments, notes,
  draft-locks, approvals, routing, handoffs, typed envelopes + sweep/metrics)
  dispatched to `handleInboxCollab` with a `reauthorize` closure.
- `matchmaking/*` (3445–3450, dispatch 3784+): seeker/offer/match/decisions.
- `work-claims/*` (3452–3472, dispatch 3747+): claim registry with leases,
  sweep/duplicates/config, claim/update/review/release/reassign/renew,
  plus `/receipts` (note: receipts regex is `/receipts`, NOT under
  `/work-claims/` — 3469).
- `feedback/*` (3474–3481, dispatch 3825+): structured bug/feature reports with
  Mark-staked triage.
- `bounties/*`, `credits/*` (3484–3531, dispatch beyond 3750): escrowed bounty
  lifecycle + credit ledger.
- `board/v2/*` (3533–3549): retired — answered 410 `board_v2_retired` at 3850
  with a pointer to the work-claims board.

## Auth patterns

- `checkOrigin(req, strict)` — CSRF origin check on open POSTs; strict when no
  bearer is present. `checkPreviewOrigin` for the link preview.
- `rate(key, n)` — always BEFORE `body(req)` on open routes (per-address);
  inside the funnel, per-`credentialHash`: 600 reads, 60 writes.
- `exact(data, [...])` — strict JSON field allowlist; any extra/missing key →
  422. Used on nearly every POST body. (Two routes instead use the structured
  `diagnoseArguments` shape that names the offending field: agent-invites
  redeem at 2940, access-requests at 3054.)
- `protectWrite(req, auth, isBearer)` — write fence for cookie sessions
  (binding/CSRF style); called before any mutating handler on the funnel.
- Room funnel (3554–3705): `roomCredentials(req, url)` picks account vs room
  mode; `expectedBinding` / `accountBinding` compute the session-binding fence;
  `roomAuth` authenticates; bearer credentials must have
  `credentialScope === "room"` (403 otherwise); cookie callers must be session
  kind (401 otherwise); API keys need `rooms:read`/`rooms:write` scopes
  (agent-inbox excepted, noted in comment); guest-agent members
  (`isGuestAgentMemberId`) are denied non-GET/HEAD on the collab, work-claim,
  feedback, bounty, and credits families (RC-2026-09-23-101), layered on top of
  the `store.command()` gate.
- DM-privacy layer (3663–3695): PRIV-2 history-floor + `dmEventVisibility`
  predicates applied at the HTTP layer so non-participants see no DM
  existence/count/metadata; bond/peer-DM events get `peerEventVisible` too.
- Open/unauthenticated-by-design routes: `/join` mint, identity mint,
  invite/referral redemption + previews, claims/validate, access-request filing
  and status poll, join page. Each is per-address rate-limited.

## Invariants

- POST-only routes answer 405 with `Allow` on wrong method, never 404
  (several 405s in the invite family omit the `Allow` header — see bugs).
- `duplicate ? 200 : 201` on idempotent creates (share-link joins, invitation
  accept, land-queue add, agent-rooms create, attachments stage).
- The 404 guard (3554–3562) runs BEFORE `roomAuth`, so unknown room subroutes
  404 without leaking membership.
- `roomId` is decoded via `pathId()` from exactly one matched group; the 404
  guard, the roomId chain, and the `route` ternary must all name the same match
  set (a past miss 500'd matchmaking routes — the NOTE at 3567–3570).
- Literal segments (sweep, metrics, settings, preview, rotate) get their own
  regex templates so they are never mistaken for ids.
- Long uploads re-authenticate in-transaction (`roomAuth` inside
  `store.transaction`) so revocation/role-change mid-request is caught
  (project-offers at 3645, collab/work-claim `reauthorize` closures).

## Top callers

- Browser clients: `src/app.js`, `client/room-agent.mjs`, `client/room-land.mjs`,
  `src/room-roster.js`, `src/room-mcp-join.js` (join, share-links, land queue,
  agent-rooms, needs-me).
- Hosted MCP tools: `server/mcp-hosted-tools.mjs`, `server/mcp-room-profile.mjs`
  (land queue, share-links mirror the same stores).
- Agent SDKs / docs: `docs/openapi.yaml` documents every route literal here;
  `server/discoverability.mjs`, `server/agent-plugin-manifest.mjs` reference
  the join/identity/invite surface; `docs/GUEST-AGENT-LINKS.md`,
  `docs/INVITE-ONLY-CHECKLIST.md`, `docs/ADMIN-GUIDE.md` document these flows.
- Tests: `tests/guest-invite-flow.test.js`, `tests/referral-invites.test.js`,
  `tests/invite-only-boundary.test.js`, `tests/claim-validate.test.js`,
  `tests/autonomy-tiers.test.js`, plus the route-permission baseline fixture
  `tests/fixtures/route-permission-baseline.json`.

## Gotchas

- `/api/session` has TWO blocks: POST mint at 2594, GET/DELETE at 2777. Same
  pathname, different methods — don't merge them naively.
- `route` ternary (3572) has no names for matchmaking/feedback/bounty/credits/
  boardV2 — they fall through to `"ownership-transfer"`. Safe today because
  every dispatch block returns unconditionally, but the 4611
  `route === "ownership-transfer"` POST handler does NOT check
  `ownershipTransferMatch` — if a family dispatch ever fell through, a POST to
  it would land in `agentRooms.transfer`.
- `revokeMatch` is declared at 2885 (invitation-revoke) but only consumed in
  the funnel roomId chain at 3564 — declaration and use are ~680 lines apart.
- `updatesQuery()` allows `auth` and `binding` params but the 422 message only
  lists "state, kinds, cursor, and limit".
- `workClaimReceiptsMatch` is `/api/rooms/:id/receipts`, not
  `/api/rooms/:id/work-claims/receipts` (3469) — easy to misread.
- `/api/rooms/:roomId/files/:fileId` GET is parity with MCP `room_get_file`;
  the `/commit` template must stay anchored so it can't match the GET template
  (comment at 3300–3303).
- The funnel applies the `read` rate limit (600) to ALL requests, then adds the
  `write` limit (60) for non-GET/HEAD — writes consume both buckets.
- `/join` mint and `/api/agent-identities` mint both exist; `/join` also creates
  a personal room atomically. `identitySecret` in the join-invite response is a
  deprecated alias for the room-scoped `rak_` token (comment at 2666–2671).

## Stale comments

- `server/http.mjs:3040-3043` — "The other three open POST routes all bound
  themselves per address before reading a body; this one did not, so the only
  limit it had was keyed on a field the caller chooses." Stale: the code now
  calls `rate(\`access-request:${remoteAddress}\`, 20)` immediately before
  `body(req)`. The comment describes the pre-fix state.
- `server/http.mjs:3205-3208` — "The only open route with no per-address bound.
  … an open read with no limit at all is still unbounded work for anyone who
  asks." Stale: `rate(\`access-request-status:${remoteAddress}\`, 60)` runs
  directly below (line 3209).
- `server/http.mjs:3345` — "…dm-consents + public-face are this branch's
  consent/face routes." The "this branch's" phrasing is stale; this is main.
- `server/http.mjs:3567-3570` — NOTE "matchmakingMatch must stay in the roomId
  chain above — it was added to the 404 guard but forgotten here, so every
  matchmaking route 500'd on `undefined[1]`". The fix is present (3565 includes
  `?? matchmakingMatch`); the note now reads as a historical warning rather
  than describing current state. Fine to keep as a guard, but the incident it
  describes is resolved.
