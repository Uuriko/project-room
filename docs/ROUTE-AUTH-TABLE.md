# Route / authentication table

Every `/api/rooms/:roomId/*` route requires a room credential: a Bearer
token scoped to the room (`Authorization: Bearer …`) or a browser session
cookie. The one exception is `POST /api/agent-identities`, which creates a
global agent identity and grants no room access by itself.

Non-`GET`/`HEAD` requests additionally pass `protectWrite` (origin check;
CSRF token for browser sessions) and a write rate limit. Store-level
authorization (owner, `manage_members`, member) is enforced inside the
`store.*` methods, not in the router.

Every room route, including `GET /api/rooms/:id/messages/:messageId/thread`,
runs through one funnel in `server/http.mjs`: path ids are decoded and
validated (`404 not_found` otherwise), the credential is selected once
(bearer account sessions are refused, browser cookies must be sessions), the
session-binding fence is passed to the store method, and the per-credential
read limit (600/min) applies before any handler runs. Unauthenticated routes
that read a body (`POST /api/agent-identities`, `POST /api/agent-invites/redeem`)
apply their per-address rate limit before the body is read.

## Mutating routes

| Method + route | Credential | Store-level authorization |
|---|---|---|
| `POST /api/agent-identities` | none (by design) | creates identity only; no room access granted; bounded by a per-address rate limit and a 5000-row table cap (`409 pilot_limit`) |
| `POST /api/rooms/:id/identity-links` | room Bearer / session | `manage_members` |
| `GET /api/rooms/:id/identity-links` | room Bearer / session | `manage_members` |
| `DELETE /api/rooms/:id/identity-links` | room Bearer / session | `manage_members` |
| `POST /api/rooms/:id/agent-invites` | room Bearer / session | `manage_members`; never grants `manage_members`/`decide`; the raw code is returned once and only an `inviteId` handle (8 hex of the stored hash) afterwards |
| `GET /api/rooms/:id/agent-invites` | room Bearer / session | `manage_members`; audit rows carry `inviteId`, never the stored hash |
| `DELETE /api/rooms/:id/agent-invites` | room Bearer / session | `manage_members`; body `{ inviteId }`; `409 invite_ambiguous` if two active rows share a handle |
| `POST /api/rooms/:id/import` | room Bearer / session | room owner only (destructive history replace) |
| `POST /api/rooms/:id/commands` | room Bearer / session | member; per-command field validation |
| `POST /api/rooms/:id/cursor` | room Bearer / session | member (own read cursor) |
| `POST /api/rooms/:id/work-sessions` | room Bearer / session | member |
| `POST /api/rooms/:id/reminders` | room Bearer / session | member |
| `POST /api/rooms/:id/agent-connections` | signed-in account session (`?auth=account`) + CSRF | room owner only (`403 owner_required`, bearer keys included) |
| `POST /api/rooms/:id/guest-agent-links` | room Bearer / session | room owner + `manage_members` |
| `POST /api/rooms/:id/share-links` | signed-in account session (`?auth=account`) + CSRF | human member + `manage_members` |
| `POST /api/rooms/:id/share-links-cancel` | signed-in account session (`?auth=account`) + CSRF | link issuer / `manage_members` |
| `POST /api/rooms/:id/invitations` | signed-in account session (`?auth=account`) + CSRF | member with invite rights (`403 account_session_required` for bearer keys) |
| `POST /api/rooms/:id/invitations/:invitationId/revoke` | signed-in account session (`?auth=account`) + CSRF | inviter / `manage_members` (`403 account_session_required` for bearer keys) |

`POST /api/invitations/preview` is unauthenticated by design (the invitation
token in the body is the credential); `POST /api/invitations/accept` needs a
signed-in account session (see Account-level writes below).
`POST /api/agent-invites/redeem` is unauthenticated by design (the one-time
code in the body is the credential); it is rate limited per address before
the body is read.

`POST /api/rooms/:id/import` reads `application/x-ndjson` through the same
bounded reader as JSON bodies (8 MB instead of 16 KB): an oversized
`Content-Length` is refused before any byte is read, and a client that stops
sending fails the request with `400 aborted` instead of holding it until the
server request timeout.

## Read routes

All `GET` routes under `/api/rooms/:id/*` (snapshot, events, export,
search, presence, capabilities, onboarding-funnel, provider-heartbeats,
reminders, agent-invites, work-*, reply-*, charter, return-brief, thread)
require a room credential with member visibility; `agent-connections`,
`diagnostics`, `share-links` and `invitations` additionally require the room
owner's or an administrator's signed-in account session (`?auth=account`),
never a bearer key. `GET /api/rooms/:id/export` returns the full event log as
one `Content-Length`-framed JSONL body (never a partial 200);
`GET /api/rooms/:id/stream` is the SSE feed.

`tests/route-auth-table.test.js` enforces the headline invariant: every
mutating room route rejects unauthenticated requests.
`tests/route-hardening.test.js` pins the funnel notes above (thread route,
agent-invite fence, limiter-before-body, import reader guards, the
`service diagnostic` log line for non-room 5xx, and the hash-free invite
audit).

## Account-level writes (account session, not room credentials)

These routes act on the browser's account session or on the account itself.
Every one of them passes `protectWrite` (`Origin` required; `X-CSRF-Token`
equal to the session's `csrf`), and every one that reads account data also
needs `X-Session-Binding`. Bearer keys are never accepted here.

| Method + route | Credential | Authorization and bound |
|---|---|---|
| `POST /api/account-session` | anonymous slot cookie + CSRF | signs the slot in with an account access key at the slot's current revision; revokes a same-browser `room_session`; 10/address+slot/min |
| `DELETE /api/account-session` | slot cookie + CSRF | signs out at the current revision; slot returns to anonymous |
| `DELETE /api/session` | room session (or bearer key) + CSRF; account mode with `?room=` | revokes the room session or signs the account slot out; bearer callers revoke their own key |
| `POST /api/share-links/join` | slot cookie + CSRF + session binding; link token in the body | joins the linked room as a new human member; duplicate `redemptionId` replays; 20/address/min |
| `POST /api/invitations/accept` | signed-in account session + CSRF | the invitation must name this account; expected revision 0; 20/session+token/min |
| `POST /api/inbox/commands` | signed-in account session + CSRF + binding | the account's own sources and drafts; importer-, transport- and reply-driver-only transitions are refused (403); 60/account/min |
| `POST /api/inbox/review` | signed-in account session + CSRF + binding | `reply.review` / `reply.update.review` on the account's own attempts; 60/account/min |
| `POST /api/inbox/simulation` | signed-in account session + CSRF + binding | loopback clients of a synthetic-transport service only (403 / 409 otherwise); 60/account/min |
| `POST /api/inbox/connections/:id/sync` | signed-in account session + CSRF + binding | owner of the connection; loopback only; 60/account/min |
| `POST /api/guest-agent-links` | room bearer key, or room / account browser session + CSRF; room named in the body | room owner + `manage_members` (same operation as `POST /api/rooms/:id/guest-agent-links`); 30/address/min |

`GET /api/inbox*` and `GET /api/account-rooms` are the matching reads: account
session plus `X-Session-Binding`, 401 `account_session_required` for any
bearer key.

## Documentation gate

`docs/openapi.yaml` describes every route above with its security scheme
(`queryAuth` / `bearerAuth` for room credentials, `accountSession` for the
browser account session, `security: []` for open routes).
`scripts/route-docs-check.mjs`, run by `npm run check`, fails when
`server/http.mjs` serves a route template the spec lacks or the spec keeps
one the server no longer serves, so this table and the spec cannot drift
apart from the code silently.

## Open routes (no credential)

The source of this list is `docs/openapi.yaml`: an operation is open exactly
when it declares `security: []`. `tests/invite-only-boundary.test.js` probes
every `/api` route the server can match without a credential and fails when
the served-open set differs from the declared set; `node scripts/open-routes.mjs
--check` (part of `npm run check`) fails when this table or
`docs/INVITE-ONLY-CHECKLIST.md` §1 omits a declared route.

| Method + route | Credential | What it discloses |
|---|---|---|
| `GET /api/health`, `GET /api/version`, `GET /api/ready` (and `HEAD`) | none | operational metadata only |
| `GET /api/guest-agent-links`, `GET /api/work-item-sessions` (and `HEAD`) | none | static contract documents, no room data |
| `GET /api/account-session` | none (creates an anonymous browser slot; 20/address/min) | `authenticated: false`, a CSRF token and session binding; `POST`/`DELETE` (sign-in/out) need the slot cookie + CSRF |
| `POST /api/agent-identities` | none (by design) | see Mutating routes above |
| `POST /api/agent-invites/redeem` | capability (invite code, 20/address/min) | 404 `invite_unavailable` for unknown codes; burns the code on success |
| `POST /api/share-links/preview`, `POST /api/invitations/preview`, `POST /api/guest-agent-links/preview` | capability (link / invitation token, 30/address/min) | room title + access only; 410 / 404 for unknown tokens |
| `POST /api/guest-agent-links/join` | capability (`gt_` link token, 20/address/min) | `read_chat` access for the linked guest member; 410 for unknown tokens |
| `POST /api/session` | the access key in the body (10/address/min) | 401 on a wrong key; sets `room_session` on success |
| `POST /api/inbox/webhooks/:connectionId` | per-connection webhook secret header | see Inbox connection routes below |

## Inbox connection routes (account session, not room credentials)

| Method + route | Credential | Store-level authorization |
|---|---|---|
| `POST /api/inbox/connections/:id/reconnect` | account session cookie + `X-Session-Binding` + CSRF (`protectWrite`) | connection owner only (404 for another account's connection); re-registers the `TELEGRAM_WEBHOOK_SECRET` hash when the bindings are set, then drains verified webhook updates through `syncTelegramConnection`; 30/min per account; works off loopback |
| `POST /api/inbox/connections/commands` | account session cookie + `X-Session-Binding` + CSRF (`protectWrite`) | connection owner only (`connection.configure` refuses another account's `accountId` with 422 `channel_account_mismatch`; `connection.disconnect` on another account's connection is 404); accepts only `connection.configure` and `connection.disconnect`, never `connection.webhook` or `page.apply`; 30/min per account; works off loopback |
| `POST /api/inbox/channel-sends` | account session + CSRF (`protectWrite`) | source owner only (404 otherwise); dispatches or reconciles an already-queued reply attempt through the deployment's transport for the source's connection (live Telegram when the bindings are set, inert fixture otherwise); 409 `channel_sending_unavailable` for email, samples and inactive connections; 30/min per account |
| `POST /api/inbox/connections/:id/sync` | account session + CSRF, loopback clients only | connection owner; recorded fixture pages (local development) |
| `POST /api/inbox/webhooks/:connectionId` | none (provider callback); `X-Telegram-Bot-Api-Secret-Token` compared in constant time with the stored SHA-256 | 409 `channel_webhook_unavailable` when no webhook inbox is wired; 401 for unknown connections and wrong secrets alike; accepted updates are held, never imported, until the owner triggers an import |
