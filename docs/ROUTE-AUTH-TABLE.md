# Route / authentication table

Every `/api/rooms/:roomId/*` route requires a room credential: a Bearer
token scoped to the room (`Authorization: Bearer …`) or a browser session
cookie. The one exception is `POST /api/agent-identities`, which creates a
global agent identity and grants no room access by itself.

Non-`GET`/`HEAD` requests additionally pass `protectWrite` (origin check;
CSRF token for browser sessions) and a write rate limit. Store-level
authorization (owner, `manage_members`, member) is enforced inside the
`store.*` methods, not in the router.

## Mutating routes

| Method + route | Credential | Store-level authorization |
|---|---|---|
| `POST /api/agent-identities` | none (by design) | creates identity only; no room access granted; bounded by a per-address rate limit and a 5000-row table cap (`409 pilot_limit`) |
| `POST /api/rooms/:id/identity-links` | room Bearer / session | `manage_members` |
| `GET /api/rooms/:id/identity-links` | room Bearer / session | `manage_members` |
| `DELETE /api/rooms/:id/identity-links` | room Bearer / session | `manage_members` |
| `GET /api/rooms/:id/agent-invites` | room Bearer / session | `manage_members` (audit view; code hashes only, never raw codes) |
| `POST /api/rooms/:id/agent-invites` | room Bearer / session | `manage_members`; never grants `manage_members` or `decide`; a non-owner cannot grant permissions it does not hold (`403 invite_scope_exceeded`) |
| `DELETE /api/rooms/:id/agent-invites` | room Bearer / session | `manage_members`; `{ codeHash }` of an unredeemed code |
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
