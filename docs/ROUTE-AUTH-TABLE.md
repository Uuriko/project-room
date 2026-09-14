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

## Read routes

All `GET` routes under `/api/rooms/:id/*` (snapshot, events, export,
search, presence, capabilities, onboarding-funnel, provider-heartbeats,
usage, reminders, agent-connections, share-links, invitations, work-*, reply-*,
charter, diagnostics, return-brief, thread) require a room credential with
member visibility. `GET /api/rooms/:id/export` returns the full event log as
one `Content-Length`-framed JSONL body (never a partial 200);
`GET /api/rooms/:id/stream` is the SSE feed. `GET /api/rooms/:id/usage` (F5)
is member-readable like its sibling dashboards because every figure derives
from data a member already reads (membership snapshot, work-session spend,
events); it returns counts only and shares the read-family rate limit.

`tests/route-auth-table.test.js` enforces the headline invariant: every
mutating room route rejects unauthenticated requests.
