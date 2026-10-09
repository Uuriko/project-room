# WAVE-400 docs — server/operator-routes.mjs + server/supervision-routes.mjs

Worktree: `/home/hatch/workspace/pr-wave400-docs-tooling` (read-only).
All claims verified against the code on 2026-10-08.

## server/operator-routes.mjs

**Mount prefix:** none. `createOperatorRoutes` is called directly from `server/http.mjs:2744`
(`if (await operatorRoutes(req, res, { url, remoteAddress, requestId: operationId })) return;`)
with no path prefix — the router itself matches `"/api/operator"` and
`"/api/operator/*"` (server/operator-routes.mjs:19–20). Paths below are full paths.
NOTE: the slice brief's "Known: operator → `/api/rooms/{roomId}/operator/...`" is
**wrong** — operator routes are top-level under `/api/operator`, not room-scoped.

| Method | Path | Auth | Params | Success | Errors |
|---|---|---|---|---|---|
| POST | `/api/operator/purge/find` | Operator token (header `Authorization: Operator <token>`, see below) | Body: `roomTitlePrefix` (opt), `roomIdPrefix` (opt), `identityNamePrefix` (opt), `accountEmail` (opt, exact match, case/space-insensitive), `createdBefore` (opt, ms epoch or date string) — at least one filter required | 200 `{ rooms: [{id,title}], identities: [{id,displayName}], accounts?: [{id,displayName}], truncated? }` | 422 `invalid_find`; (404 `not_found` for missing/invalid token) |
| POST | `/api/operator/purge/plan` | Operator token | Body: `targets` (required, 1–20, each `{kind: room\|identity\|account, id}`), `reason` (required, 1–500 plain chars), `allowActiveMembers` (opt bool, default false) | 200 `{ planId, planHash, confirmToken, expiresAt, reason, warnings, counts, targets, totalRows }` (token TTL 10 min, single-use) | 422 `invalid_purge` / `invalid_target` / `purge_too_large`; 404 `unknown_target`; 403 `protected_room`; 409 `active_members` |
| POST | `/api/operator/purge/execute` | Operator token | Body: **exactly** `planId` + `confirmToken` (any extra key → 422) | 200 `{ planId, planHash, result: "executed", targets, totalRows }` | 422 `invalid_purge`; 401 `invalid_confirmation` (bad/expired token); 409 `confirm_used` (replay) / `plan_changed` (counts moved — nothing deleted); 404 `unknown_target`; 403 `protected_room`; 409 `active_members` |
| GET | `/api/operator/actions` | Operator token | Query: `limit` (opt, default 50, 1–200) | 200 `{ actions: [...] }` (latest operator audit rows) | 422 `invalid_limit`; 405 for non-GET |
| GET | `/api/operator/status` | Operator token | none | 200 `{ version: {sourceRevision, buildId}, ready, jobs: "see /api/health/jobs", lastColdStart, tables: [{table,rows}…], partial, skippedTables?, retention: null, operatorActions: [last 10] }` | 405 for non-GET |
| GET | `/api/operator/drift` | Operator token | Query: `main` (required-ish; a commit SHA 7–64 hex, or `"unstamped"`) | 200 `{ deployed, main, match }` — short SHAs match by prefix | 422 `invalid_revision` (via ServiceError) |

**Auth (elevated-permission gate):** All six routes share one gate at
server/operator-routes.mjs:21–28 — `Authorization: Operator <token>` (scheme is
literally `Operator`, not `Bearer`), token ≥32 bytes / ≤256 chars, SHA-256
compared with `timingSafeEqual` against `ROOM_OPERATOR_TOKEN_SHA256` (hex digest).
Entire surface is off when the env var is unset/blank/not a 64-hex digest → the
router returns `false` and the request falls through to the same `not_found` as
any unknown URL (server/http.mjs:2744 comment). Wrong token → **404 not_found, not
401** (deliberately non-oracular). Rate limit: `rate('operator:<ip>', 10)` per
remote address (10 req/min window, server/operator-routes.mjs:26). Room/account
session cookies are never an operator credential — a request carrying one without
the `Operator` header is 404'd.

**Behavioral notes**
- Purpose: God-mode admin surface for irreversible data destruction
  (purge plan/confirm/execute), audit of every operator action, and build-drift
  checks. Purge is the only write-capable surface in the codebase that deletes
  rows across arbitrary tables (rooms, identities, accounts) in one transaction.
- `plan`/`execute` is a two-phase commit with anti-replay: `confirmToken` is an
  HMAC-signed `{planId, planHash, exp}` with a per-process secret (so it dies on
  restart), 10-minute TTL, marked used on success; `execute` re-counts and
  refuses with 409 `plan_changed` if any row moved between plan and execute
  (server/operator-purge.mjs:402–405).
- `execute` drops `BEFORE DELETE` triggers (except `writer_v*` and `WHEN`-guarded
  ones) during the delete and restores them in a `finally` (`liftDeleteGuards` /
  `restoreGuards`, operator-purge.mjs:202–236); enables `public_work_claim_writer_permit`
  for the transaction only.
- `find` never echoes the searched email address — only ids/display names
  (operator-purge.mjs:329 comment). Identity purge revokes instead of deleting
  (`revoked_at` set), account purge runs the full account-deletion flow.
- `drift` defaults `main` to `null` when the query param is absent → 422
  `invalid_revision` ("Pass main as a commit SHA") — there is no "no-arg" drift check.
- Power flag: `/api/operator/purge/execute` irreversibly deletes up to 200k rows
  in one transaction across ~every room-scoped table. The gate is the operator
  token alone — there is no room-owner consent or second human in the loop.
  `protected_room` covers only `invite-only-pilot` + `ROOM_OPERATOR_PROTECTED_ROOMS`.

## server/supervision-routes.mjs

**Mount prefix:** **UNMOUNTED — not reachable.** `handleSupervisionRoutes` has zero
callers in `server/` (grep over server/ finds only the test file
`tests/supervision-routes.test.js`; the header itself says mounting is deferred to
an integration lane, supervision-routes.mjs:1–13). Intended mount:
`/api/rooms/{roomId}/supervision/cards*` mirroring `handleWorkClaims`, with route
keys `{list,derive,seen,pick,retract,confirm,dismiss,snooze,refetch}`. The table
below uses the intended full paths; all are currently 404 in production.

| Method | Path | Auth | Params | Success | Errors |
|---|---|---|---|---|---|
| GET | `/api/rooms/{roomId}/supervision/cards` | Room member auth (`auth.member.id` required) | Query: `include=snoozed` (opt) | 200 `{ roomId, viewerId, cards: [sorted, suggestions attached] }` | 401 `unauthorized`; 500 `supervision_unwired` |
| POST | `/api/rooms/{roomId}/supervision/cards` | Room member auth | (internal roll-up tick; no body params used) | 200 `{ roomId, derived, cards }` | 401; 500 |
| POST | `/api/rooms/{roomId}/supervision/cards/{id}/seen` | Room member auth (404 = "not in YOUR queue") | Path `cardId` matching `[A-Za-z0-9_-]{1,128}` | 200 `{ card, seen: true }` | 404 `unknown_card`; 422 `invalid_input`; 409 transition errors |
| POST | `/api/rooms/{roomId}/supervision/cards/{id}/pick` | Room member auth | Body: `suggestionIndex` (required, 1-based int into `decideSuggestions(card)`), `holdMs` (opt, default `DEFAULT_UNDO_HOLD_MS`) | 200 `{ card, suggestion, intent: {journaled, undoDeadlineMs, badge, note} }` — confirm-gated suggestions instead return `{ card, requiresConfirm: true, challenge: {suggestion, badge} }` and record nothing | 422 `invalid_input` / `nothing_to_hold` (navigation-only suggestion); 404; 409 |
| POST | `/api/rooms/{roomId}/supervision/cards/{id}/retract` | Room member auth | Path `cardId` only | 200 `{ card, retracted: true }` | 404; 422; 409 `illegal_transition` / `undo_expired` / `undo_window_open` |
| POST | `/api/rooms/{roomId}/supervision/cards/{id}/confirm` | Room member auth | Body: `confirm: true` (required, literal) | 200 `{ confirmed: true, card, write: <approved payload>, apiNote }` — or `{ confirmed: true, replayed: true, ... }` on lost-response replay | 422 `confirmation_required`; 404; 409 `confirm_required` |
| POST | `/api/rooms/{roomId}/supervision/cards/{id}/dismiss` | Room member auth | Body: `note` (opt) | 200 `{ card, dismissed: true }` | 404; 422; 409 |
| POST | `/api/rooms/{roomId}/supervision/cards/{id}/snooze` | Room member auth | Body: `snoozeFor` ∈ {`1h`,`4h`,`tomorrow`} XOR `untilMs` (ms epoch; one required) | 200 `{ card, snoozedUntilMs }` | 422 `invalid_input`; 404; 409 |
| POST | `/api/rooms/{roomId}/supervision/cards/{id}/refetch` | Room member auth | Body: `fired: true` (opt; reports client-side dispatch of a held write) | 200 `{ card, fired: true }` on delivery report; `{ card, stale: true }` if source affirmatively resolved; `{ card, stale: false, verified: bool }` otherwise | 404; 422; 409 |

Error-code mapping is centralized in `supervisionHttpError` (supervision-routes.mjs:65–80):
SupervisionError codes → 422 `invalid_input|confirmation_required|nothing_to_hold|not_confirm_gated`,
409 `illegal_transition|undo_expired|undo_window_open|confirm_required`. Unknown route key → 404
`unknown_supervision_route`; wrong method → 405 `method_not_allowed`; no member auth → 401
`unauthorized`; store not wired (B5 dependency) → 500 `supervision_unwired`.

**Behavioral notes**
- Purpose: per-operator supervision inbox — 9 routes over triage "cards" (blocked
  lanes, review requests, done receipts, unanswered messages) with undo-hold
  semantics: `pick` journals intent and holds the room write until the undo
  deadline; `retract` cancels; `confirm` approves confirm-gated (money/merge/deploy)
  suggestions and hands the payload back for the client to fire; `refetch {fired:true}`
  records delivery (supervision-routes.mjs:270–290).
- Identity isolation: every route re-authenticates and scopes storage to the
  caller's own `memberId` — a 404 means "no such card in YOUR queue", so an agent
  can never clear another lane's state (header, supervision-routes.mjs:31–34).
- Staleness rule: only affirmative live evidence retires a card; unknown sources
  keep it ("notification ≠ truth", supervision-routes.mjs:45–47, 307–309).
- `derive` upserts but never downgrades a terminal/triaged state
  (supervision-routes.mjs:223–236).
- `confirm` has an idempotent replay path: if the card is already
  `pending_undo` with a confirm-gated picked suggestion, retry returns the same
  approved write instead of 409ing, so a lost first response can't strand an
  approved-but-never-fired action (supervision-routes.mjs:290–300).
- Power flag: this is the confirm gate for money/merge/deploy-class suggestions —
  the v1 decider never *suggests* them but the `confirm` route's gate is live for
  them (header, supervision-routes.mjs:60–62). Entire module is currently dead code
  awaiting the integration lane; rate limits were deferred to the http.mjs mount
  point and do not exist yet.

**Suspected bugs**
- BUG? `server/supervision-routes.mjs:223` — the `derive` route header says
  "(internal: roll-up tick, not clients)" but nothing enforces it: any
  authenticated room member can POST `/cards` and mint cards in their own queue.
  Impact bounded (derive only adds new cards, never downgrades), but the
  "internal" boundary is documentation-only.

**Stale doc flags**
- STALE `docs/BACKUPS.md:7` — "`GET /api/operator/export` streams NDJSON" —
  contradicts `server/operator-routes.mjs:10–16` (the ROUTES table has no
  `/api/operator/export`) and `server/http.mjs` (no such route anywhere); the
  documented route returns 404 `not_found`.

DONE: 15 endpoints, 1 stale flag, 1 suspected bug
