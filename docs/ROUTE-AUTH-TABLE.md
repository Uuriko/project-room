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
| `POST /api/rooms/:id/agent-connections` | room Bearer / session | member |
| `POST /api/rooms/:id/guest-agent-links` | room Bearer / session | room owner + `manage_members` |
| `POST /api/rooms/:id/share-links` | room Bearer / session | human member + `manage_members` |
| `POST /api/rooms/:id/share-links-cancel` | room Bearer / session | link issuer / `manage_members` |
| `POST /api/rooms/:id/invitations` | room Bearer / session | member with invite rights |
| `POST /api/rooms/:id/invitations/:invitationId/revoke` | room Bearer / session | inviter / `manage_members` |

`POST /api/invitations/preview` and `POST /api/invitations/accept` are
unauthenticated by design (invitation token in the body is the credential).
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
reminders, agent-connections, share-links, invitations, work-*, reply-*,
charter, diagnostics, return-brief, thread) require a room credential with
member visibility. `GET /api/rooms/:id/export` returns the full event log as
one `Content-Length`-framed JSONL body (never a partial 200);
`GET /api/rooms/:id/stream` is the SSE feed.

`tests/route-auth-table.test.js` enforces the headline invariant: every
mutating room route rejects unauthenticated requests.
`tests/route-hardening.test.js` pins the funnel notes above (thread route,
agent-invite fence, limiter-before-body, import reader guards, the
`service diagnostic` log line for non-room 5xx, and the hash-free invite
audit).
