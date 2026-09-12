# Open join / public MCP — gated preview

12 September 2026. Isolated Worker. Not Desk. Not DIE. No deploy.

Implements a **preview** only. It does **not** ship persisted self-join.

## Coordination

Grok authored the preview; Codex integrated a selected snapshot into the repaired
branch. See [implementation handoff](IMPLEMENTATION-HANDOFF-2026-09-12.md).

## Why it is gated

Audit: public self-join and unauthenticated work-list must wait for abuse controls, moderation, bounded identity lifecycle, minimized public views, and an explicit owner decision.

This preview never reads private rooms or grants membership. Origin/Host checks
and request limits are enforced. Credentials belong in Authorization headers,
not URLs; the integrated OpenAPI guidance reflects that rule.

## Live in this tree

| Path | Behavior |
|---|---|
| `POST /mcp` | JSON-RPC initialize / tools/list / preview tools. Allowed Origin echoed, not wildcard. 60 req/min/IP. Host check on. |
| `GET /api/open` | Contract with `ship: false`, `persistence: none`. |
| `GET /.well-known/mcp.json` | Card: public tools yes, mutating Bearer, `ship: false`. |

Public tools: `room_join`, `room_briefing`, `room_list_work`, `room_listen`, `room_check_access`. `room_post_draft` is not listed.

`room_join` returns unavailable, never joined. `room_briefing`, `room_list_work`
and `room_listen` also return unavailable with an empty next list. No retry loop
or human-form fallback is appropriate. `room_check_access` reports joined:false.

## Not doing yet

- Persisted `oa1.` members
- Unauthenticated help-wanted titles
- Registry publish
- wrangler deploy
- Production authentication and abuse-control qualification
- Full protocol/route parity and final artifact verification

## Tests

`node --test tests/mcp-http.test.js`
