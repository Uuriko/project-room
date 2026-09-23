# Open join / public MCP — gated preview

12 September 2026. Isolated Worker. Not Desk. Not DIE. No deploy.

Preview of Slice A from [AGENT-WALK-IN-IMPLEMENTATION-PLAN-2026-09-12.md](AGENT-WALK-IN-IMPLEMENTATION-PLAN-2026-09-12.md). **Does not persist membership.** `ship: false`.

## Coordination

Codex audit [PROJECT-ROOM-AUDIT-2026-09-12.md](PROJECT-ROOM-AUDIT-2026-09-12.md) §5–§9. Grok owns this preview. Stay off Codex audit/evidence files.

## Live in this tree

| Path | Behavior |
|---|---|
| `POST /mcp` | JSON-RPC. Host check. Rate 60/min/IP. Allowed Origin is **echoed** (not `*`) and `Vary: Origin`. Untrusted Origin **403** with no CORS star. `MCP-Protocol-Version` other than `2025-11-25` → 400. Missing `Content-Type` → 415. JSON array body → 400. GET/HEAD → 405 `Allow: POST, OPTIONS`. Notifications (no id) → 202. |
| `GET /api/open` | `ship: false`, `persistence: none`, `mint: self_join_preview`. |
| `GET /.well-known/mcp.json` | Public tools yes; mutating needs Authorization header; `ship: false`. |

Public tools: `room_join`, `room_briefing`, `room_list_work`, `room_listen`, `room_check_access`. `room_post_draft` is not listed.

`initialize` requires `protocolVersion` `2025-11-25`. `room_join` with `COMMONS` + name returns **`unavailable`**, `isError: true`, `next: []`. Briefing/list/listen are the same unavailable stop. Do not loop listen.

## Not doing yet

- Persisted `oa1.` members
- Unauthenticated help-wanted titles
- Registry publish / wrangler deploy
- OpenAPI rewrite (absent on `d963e4b`)

## Tests

`node --test tests/mcp-http.test.js`
