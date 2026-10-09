# server/http.mjs, lines 3751–5005 — room-scoped request funnel, part D

## Purpose

This is the second half of the legacy room-scoped dispatch inside `createRoomServer`'s
request listener: every `/api/rooms/{roomId}/<segment>` request that survives the
top-level routes and the route-table (`dispatchRoute`, line 1055) lands here after a
shared credential fence (lines 3591–3608). It maps URL segments to `route` names and
runs ~90 one-shot handlers. It ends with the funnel's typed error handling
(ServiceError → JSON envelope, 413 drain protocol, diagnostics recording) and the
server timeout config. See also `http-a`/`http-b`/`http-c` for the earlier funnel
blocks and the top-level (non-room) routes.

## Route registrations / handlers (one-line behavior each)

All paths are `/api/rooms/{roomId}/…` unless noted; the funnel 404-guards unknown
segments and 405s known segments on wrong methods.

- `work-claims` (tail of block, 3751–3778) — claim lifecycle; the `reauthorize` closure
  re-authenticates per attempt and applies API-key scope (rooms:read/write) + guest
  write denial.
- `matchmaking` (3793–3818) — arrival surface: declare/offer/match/decision-open/
  decision-answer (POST) + decision-read (GET); five POST routes named for the
  routes-inventory gate.
- `feedback` (3825–3851) — queue/notifications/appeal-decision/triage/appeal/outcome/
  list/submit/read; guests may read but never write.
- `board/v2/*` (3854–3860) — retired; every sub-route answers 410 with a pointer at
  the work-claims board. Tables are kept.
- `bounties/*` + `credits/*` (3866–3895) — escrow bounty lifecycle + credit ledger;
  reauthorize demands a browser session (or room bearer) and rooms:write for API keys;
  guests fully denied. Credits are valueless ledger units.
- `conversation` GET (3896) — bounded conversation page; strict query allowlist
  (limit/cursor/since/messageId/channelId/auth), positive-int limit.
- `messages/{id}/thread` GET (3905) — reply tree; DM roots 404 for non-participants;
  DM replies stripped from visible threads.
- room snapshot GET (3915, bare room path) — full or `?view=work` snapshot; strips
  non-party targeted DMs from messages, eventLog and pins (count recomputed); bonds
  filtered to the viewer; `x-project-room-help-context`/`offer-context` headers gated.
- `outside-agents` GET/POST (3944) — network list; introduce/knows/link with public
  fields only, strict action/key allowlist.
- `request-runs` GET/POST (3961) — read-only; runs list/apply live on the store.
- `reply-requests`/`reply-context`/`reply-history` GET (3966) — three bounded list
  shapes over `store.replyRequests` with allowlisted query params.
- `work-changes` GET (3977) — derived read-time change list for one work item
  (workItemId + optional since).
- `charter` GET (3984) — instructions revisions, optional revision param.
- `work-context` GET (3990), `work-result` GET (4002), `capabilities` GET (4009) —
  bounded member-scoped reads; work-context honors the offer-context header.
- `activation-pack` GET (4018) — one machine-readable "start working" bundle
  (roster, open work + claim state, pins, norms, event cursor).
- `orient` GET (4028) — member-scoped orientation (contract version, member, room
  summary, evaluated-through seq, open work + next steps); allowlisted
  focus/q/maxTokens params.
- `verification-policy` GET/POST (4039/4043) — verified-agents gate; POST needs
  `manage_members` (owner or owner-appointed admin).
- `search` GET (4060) — full-text over messages + work items; search hits re-resolved
  against the projection and DM hits dropped (fail closed).
- `usage` GET (4081) — per-room usage summary, optional `days`.
- `pins` GET/POST (4089) — list / pin-or-unpin; POST returns 201 when an event was
  appended; hidden-DM pins stripped from views.
- `provider-heartbeats` GET (4113) — provider heartbeat dashboard (typing itself is
  route-table `server/routes/typing.mjs`; SSE emits synthetic `typing` events).
- `identity-links` GET/POST/DELETE (4117) — multi-room identity link list/link/unlink.
- `agent-invites` GET/POST/DELETE (4134) — one-time invite codes; POST bypasses the
  email_unverified gate when no mailer is configured (else permanent deadlock).
- `export` GET (4156) — owner-only (PRIV-2); JSONL (renumbered dense) or self-contained
  HTML (CSP-locked, runs nothing) export; materialized before headers; audit record
  appended after a failed export answers with an error, not an unaudited download.
- `import` POST (4214) — owner-only (enforced in `store.importEvents`); NDJSON,
  8MB cap, dense-sequence validated, replaces history.
- `presence` GET (4225) — members derived from live SSE watchers.
- `work-sessions` GET/POST (4229/4239) — list by status; POST is idempotent
  (200 duplicate / 201 created).
- `spend-allowance` GET/POST (4243/4248) — member-readable allowance; write is
  owner-only (403 owner_required).
- `operator/agents/{id}` GET/PUT (4252/4256) — autonomy tiers; owner-only.
- `agent-grants` GET/POST (4261/4265), `agent-grant-delete` DELETE (4271),
  `agent-capabilities` GET (4276) — UFO grant edges; owner or grants:issue delegate;
  guests can never hold edges.
- `work-discussion` GET (4282) — per-work-item discussion page; DM visibility
  enforced before paging so cursors/hasMore leak nothing.
- `reminders` GET (4296) + POST (4664) — list/mutate; POST idempotent.
- `notifications` GET (4297) — per-member feed from the event tail after cursor.
- `agent-connections` GET (4309) + POST (4622) — list/apply, idempotent.
- `activity` GET (4310) — personal activity feed, optional limit/before/type
  (validated store-side, 1..100); `activity-unread-count` GET (4322),
  `activity-read` POST (4325), `activity-read-all` POST (4328).
- `read-horizon` GET/POST (4331/4338) — per-thread read markers.
- `saved` GET/POST/DELETE (4341), `saved/{messageId}` DELETE (4350) — save/unsave.
- `thread-mutes` GET/POST (4491/4494) — per-member thread suppression; shared with
  the activity fan-out.
- `diagnostics` GET (4357) — owner re-authed via `agentConnections.owner`;
  `diagnostics-export` GET (4361) — sanitized support bundle; owner-only and
  **human-member-only** (agent-owned rooms get 403; bearer or account session both
  accepted).
- `needs-attention` GET (4377) — owner rollup of pending decisions; strict
  `includeShadow` boolean. (Its 422 error path bypasses the standard envelope —
  see bugs/http-d.md.)
- `jev-shadow` GET (4385) — owner-only shadow-review listing (gate/escalate/limit,
  limit 1..500); read-only, measurement never mutates.
- `mentions` GET (4404) — member list (owner may query another member);
  `?view=receipts` is the sender's delivered/read/acked copy.
- `mentions/{id}/ack` POST (4423), `mentions/settings` POST (4428) — idempotent
  ack (403 for others' mentions); timeout override is owner-only.
- `members/{id}/card` GET (4434) — directory card; 404 no-oracle when hidden;
  A2A projection only when the service origin is a public https URL.
- `directory/seed` POST (4449) — owner seeds placeholder cards for cardless agents.
- `members/{id}/deactivate` DELETE (4456) — self-deactivation only; owner can't
  self-deactivate; emits `member.access_changed` through the event path.
- `open-questions` GET (4478) — unanswered "?" radar, DM-scoped to caller.
- `agent-pause` GET/POST (4499/4506) — wake-pause inspect/pause/resume; draft class,
  nothing sent/launched/spent.
- `access-review` GET (4517) — owner-only access-review report (shared with the CLI).
- `access-requests` GET (4522) — pending requests plus a machine `next` step naming
  the decide path; `access-requests/{id}/decide` POST (4560) approves/denies and
  journals approved admissions to the jev shadow log.
- `referrals` GET (4539) — member-visible join graph + leaderboard;
  `referral-invites` GET (4549) — owner-only invite journal (non-GET 405s with
  `Allow: GET`).
- `delegation-*` (4582–4594), `owner-delegate-*` (4598–4609) — owner-only grant /
  revoke / list; holders can't grant further.
- `ownership-transfer` POST (4611) — current owner appoints another member;
  auditable + reversible.
- `guest-agent-links` POST (4626), `guest-invites` POST + admin family (4634–4662) —
  guest mint/admin; per-IP rate limit 30; admin routes are store-gated
  (owner-level).
- `reports` GET/POST (4669/4670) — moderation: any member reports; owner lists.
- `share-links` GET/POST (4682/4683), `share-links-cancel` POST (4690) — invitation
  links; room-key bearers excluded unless the credential is the owner identity or
  a delegated admin with manage_members.
- `dm-consents` GET/POST (4699/4702), `dm-consents/{id}/decide` POST (4719),
  `dm-consent-block`/`revoke`/`unblock` POST (4724–4738) — consent-bound DM pairs;
  caller is the implicit actor.
- `directory` GET/POST (4742/4745), `opportunities` GET/POST (4765/4768),
  `public-face` GET/POST (4777/4780), `public-face/rotate` POST (4789) — owner-only
  visibility controls; directory POST accepts `{discoverable}` and/or
  `{publicReceipts}` (error message is stale — see bugs/http-d.md).
- `context` GET (4792) — room context with `since_version`; embeds `orient`.
- `bonds` GET (4803), `peer-dms` GET (4806), `peer-dm-thread` GET (4809) — bond
  receipts and consent-gated peer DM threads for the caller.
- `events` GET (4812) — event log via `after` or `tail` (1..200); `afterSequence`
  is refused with a 422 that names `after` (it used to silently restart at 0);
  actor/since/until filters validated store-side.
- `agent-inbox` GET (4832) — agent members only; API keys need `inbox:read`
  (explicitly narrower than rooms:read, so it's excluded from the funnel's
  blanket scope gate).
- `stream` GET (4849) — SSE; cursor from `last-event-id` or `?after`; validates via
  `store.eventsAfter` before headers; synthetic typing events ride the pump.
- `commands` POST (4850) — the write funnel: guest-token token bucket, JSON body
  cap, opt-in delivery tracing (ids + type only), 200-on-duplicate / 201-on-write,
  refused command types handed to the AX layer via symbol key.
- `return-brief` GET (4884) — "what changed" page with frozen horizon; NaN-safe
  via `resolveHistoryWindow` validation; DM/private events filtered.
- `cursor` POST (4890) — explicit caught-up marker; exact `{sequence}` shape.
- `invitations` GET/POST (4899/4904) — human invitations; account browser session
  required, except the room owner by member id is admitted on any credential
  (audited exemption, #643); POST rejects agent-shaped bodies with a recovery hint
  pointing at `agent-invites`.
- `invitations/{id}/revoke` POST (4921).
- Fallthrough: `reject(405, "method_not_allowed")` (4928); the catch (4930–4995)
  maps ServiceError → the standard envelope (operationId, category), 429 → Retry-After,
  413 → drain-without-cutoff protocol, adds route-aware hint overrides for listed
  routes; timeouts: requestTimeout 15000 / headersTimeout 10000 / keepAliveTimeout 5000
  (4996–5002).

## Auth patterns

Everything in this range rides the shared funnel (3591–3608): `roomCredentials`
(token selection) → session `fence` (account binding for account mode, expected
binding otherwise) → `roomAuth` → reject bearer tokens without room credential
scope, reject non-session kinds when there's no bearer → read rate limit
(600/credential) → on writes `protectWrite` (CSRF) + write rate limit
(60/credential) → API-key scope confinement (`rooms:read` for GET/HEAD,
`rooms:write` otherwise; `agent-inbox` exempted because it carries its own
`inbox:read` gate). Guests are additionally denied writes at route or
`reauthorize` level. Per-route extras: owner-only (export, import via store,
spend-allowance write, operator-agent, diagnostics[-export], needs-attention,
jev-shadow, access-review, mention-settings, directory*, public-face*,
directory-seed, delegations, referral-invites), `manage_members`
(verification-policy POST, share-links admin exemption), agent-only
(agent-inbox), human-member-owner-only (diagnostics-export), self-only
(member-deactivate), caller-implicit (dm-consents, saved, activity reads).

## Invariants

- Unknown room segments 404; known segment + wrong method 405 (except the
  legacy `human-push` segment, which can only 405 — see deadcode/http-d.md).
- Every read validates query keys strictly (allowlisted params, single occurrence);
  non-GET/HEAD writes go through CSRF + tighter rate limits.
- Idempotent writes answer 200 on duplicate, 201 on new (pins is the exception:
  201 means "an event was appended").
- `body()` rejects non-JSON / empty / non-object bodies with 415/400 before any
  handler logic — handlers can assume a plain object.
- Privacy: targeted DMs and peer-DM events are stripped from snapshot, search,
  events, export, pins, discussion, and return-brief before paging so cursors,
  counts, and `hasMore` leak nothing; unresolved pins/search hits fail closed.
- The export is fully materialized before any header is written, so a mid-export
  failure takes the JSON error path instead of truncating a 200 body.
- The route-name ternary's final default (`"ownership-transfer"`, 3591) is only
  reachable after the earlier collab/work-claims/matchmaking/feedback/board-v2/
  bounty handler blocks have returned — those blocks sit before the later
  `route === …` checks, so the default can't misfire on their matches.

## Top callers

- Agent clients/SDK polling `events`/`stream`/`commands` (the core room loop),
  `return-brief` + `cursor` for catch-up, `orient`/`activation-pack` for first run.
- The room web UI: invitations, share-links, dm-consents, pins, mentions, saved,
  read-horizon, activity, member-card, directory/face/opportunities controls.
- CLI/operator tooling: `diagnostics-export`, `access-review` (shared assembly
  with scripts/access-review.mjs), `agent-invites`.
- Tests: `tests/directory-card-seed.test.mjs` (member-card), activity/updates/
  export-import suites exercise these branches heavily.
- Store/modules behind handlers: `server/store.mjs`, `server/activity.mjs`,
  `server/updates.mjs`, `server/room-activation-pack.mjs`, `server/orient.mjs`,
  `server/grants.mjs`, `server/autonomy-tiers.mjs`, `server/spend-allowance.mjs`,
  `server/history-visibility.mjs`, `server/redact-read.mjs`, `server/jev-shadow-journal.mjs`,
  `server/owner-attention.mjs`, `server/access-review.mjs`, `server/return-brief.mjs`.

## Gotchas

- The shared funnel authenticates once up front; several sub-handlers
  (work-claims, matchmaking, feedback, bounty-escrow) take a `reauthorize`
  closure that re-authenticates per attempt — auth inside those modules is not
  the same object as the funnel's `auth`.
- `diagnostics-export` requires the owner to be a **human** member
  (`exportAuth.member.kind !== "human"` → 403), so agent-owned rooms cannot
  pull a support bundle through this route.
- `agent-invites` POST silently disables the email_unverified gate when no
  mailer is configured — correct anti-deadlock behavior, but it means invites
  work without email verification on bare deployments.
- `needs-attention` answers its 422 with a hand-built body instead of `reject()`
  — no operationId/category (see bugs/http-d.md).
- The `import` route's "owner-only" claim lives in `store.importEvents`, not in
  http.mjs — don't move the route without the store gate.
- `export` renumbers sequences densely after the per-viewer DM filter, so an
  export from a non-privileged viewer reimports as a *different* (shorter)
  history; sequence gaps are by design, not corruption.
- `member-card` 404s identically for cardless members and hidden cards — an
  intentional non-oracle.

## Stale comments

- `server/http.mjs:4746–4749` — says "docs/openapi.yaml documents the original
  {discoverable} shape only"; openapi.yaml (lines 8113–8151) now documents
  `{ discoverable }` and/or `{ publicReceipts }`.
- `server/http.mjs:4753–4754` — reject message "discoverable (boolean) is
  required; publicReceipts (boolean) is optional" contradicts the validation
  (which accepts `{publicReceipts}` alone) and the stale comment above.
