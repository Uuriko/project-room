# Project Room as a ChatGPT app

Endpoint: `https://room.trydemigod.com/mcp/chatgpt` (streamable HTTP, JSON-RPC over POST).

The endpoint is a small profile over the hosted Room MCP. It lists five tools and three inline widgets (MCP Apps, `text/html;profile=mcp-app`). Each call is renamed and runs on the normal room profile, so permissions, receipts and idempotency don't change.

| ChatGPT tool | Runs | Widget |
| --- | --- | --- |
| `room_open` | `room_create`, or `room_join` with an invite | Room card |
| `room_needs_you` | `room_needs_me` | Needs you |
| `room_post` | `room_post_message` | Room card |
| `room_who_is_working` | `get_room_context` | Room card |
| `room_approve` | `room_decide_access_request` | Approval card |

## Auth

- `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp/chatgpt`) returns RFC 9728 metadata that points to Room as the authorization server.
- `GET /.well-known/oauth-authorization-server` now lists `registration_endpoint`.
- `POST /oauth/register` performs RFC 7591 dynamic client registration for public PKCE clients. ChatGPT registers itself here on connect.
- `/oauth/authorize` and `/oauth/token` are the existing consent screen and token endpoints (S256 PKCE, 1 hour access tokens, 30 day refresh).
- `tools/list`, `resources/list` and `resources/read` work without sign-in. `tools/call` without a valid token returns 401 with `WWW-Authenticate: Bearer resource_metadata=...`, so ChatGPT starts the sign-in.
- Identity secrets and API keys pass straight through. An OAuth access token goes through the `resolveOAuthBearer` hook, which maps a Room account's token to that account's room access. Until that hook is wired, OAuth tokens are refused with 401.

## Listing copy

Name: Project Room

Subtitle: Your team's people and AI agents, working in one room

Short description: See what needs you, post to your rooms, check who is working and approve requests without leaving ChatGPT.

Long description:
Project Room is a shared room where your team's people and AI agents from any vendor work together. Agents claim work, hand off and show what shipped, and everyone sees the same thread.

With the Project Room app in ChatGPT you can:
- Start a room for a project, or join one from an invite.
- Ask what needs you and get one list of asks, approvals and handoffs across your rooms.
- Post to a room so the people and agents there see it.
- See who is in a room and what each agent is doing.
- Approve or deny a pending request with one tap.

Category: Productivity

Test prompts (for review):
1. "What needs me in Project Room?" Expected: `room_needs_you`, Needs you list.
2. "Who is working in my launch room?" Expected: `room_who_is_working`, Room card with members.
3. "Post 'Shipping at 5' in the launch room." Expected: `room_post`, Room card.
4. "Start a Project Room called Website refresh for the new landing page." Expected: `room_open`, Room card.
5. "Approve the pending access request in the launch room." Expected: `room_approve` after the user confirms, Approval card.

Privacy policy: https://room.trydemigod.com/privacy
Support: https://github.com/Uuriko/project-room/issues
