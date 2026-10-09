# server/mcp-http.mjs

Streamable HTTP MCP transport. Two personalities on one URL:

- **Anonymous**: the public join surface — `room_join_packet`, `room_join_kits`,
  `room_join_prompt`, `room_mcp_snippet` (all read-only), plus public-work
  tools and identity-mint tools dispatched to the live Room service.
- **Authenticated** (`Authorization: Bearer pri_…`): the Room Worker profile
  (`server/mcp-room-profile.mjs`) with the full enrolled tool catalog.

Writes from authenticated tools go through `RoomStore.command`. Served both
as a Fetch handler (Workers) and a Node `req`/`res` adapter.

## Public API

| Export | Behavior |
|---|---|
| `MCP_JOIN_TOOLS` | The 4 anonymous join tools (frozen descriptors with MCP annotations). |
| `handleMcpJoinRpc(message, {mcpUrl})` | Pure JSON-RPC dispatcher for the anonymous surface: `ping`, `initialize` (version negotiation with `_meta.protocolVersionSubstituted` instead of silent swap, #1529), `tools/list` (no cursor pagination), `tools/call`, `server/discover` → 32601. Unknown tools get a closest-name suggestion — suppressed when the match is a hosted tool name (#1528 least-exposure). |
| `dispatchRoomMcp(message, opts)` | Routes anonymous vs authenticated. Empty `Bearer` (unset secret variable) counts as anonymous. Unknown credential without a roomMcp impl → `MCP_AUTH_REQUIRED` (-32001). |
| `legacyMcpHeaders(authorization)` | Case-insensitive `bearer` scheme (RFC 7235); `pri_` tokens get Deprecation + Link headers. |
| `mcpRpcStatus(reply)` / `mcpAuthHeaders(reply)` | 401 for auth-required errors (with `WWW-Authenticate: Bearer`, QA5-gb-AX-4), else 200. |
| `mcpJoinCorsHeaders()` | CORS + `MCP-Protocol-Version` expose. |
| `roomMcpFetchResponse(request)` | GET/HEAD/OPTIONS on the MCP path: serves the join doc (JSON or text by Accept) or 405. Returns null for non-POST so the caller falls through. |
| `roomMcpFetchPost(request, options)` | POST: parses JSON-RPC, dispatches, serializes the reply with CORS + auth headers. Invalid JSON → 400; dispatch throw → -32603 internal error (no success claimed). |
| `writeRoomMcpNode(req, res, url, opts)` | Node http adapter: same semantics as the Fetch pair, with `Content-Length` set. |

Re-exports: `isRoomMcpPath`, `MCP_VERSION`.

## Invariants

- The join path is always anonymous — hosted tool names are never its catalog
  to give (suggestion suppressed for hosted names).
- Notifications (no `id`) return null → 202, never a reply.
- `tools/list` rejects any cursor with -32602 (no pagination supported).
- Authenticated dispatch without a `roomMcp` implementation fails closed with
  `MCP_AUTH_REQUIRED` rather than falling through to the join surface.

## Top callers

- `server/http.mjs` — mounts the MCP endpoint.
- `server/mcp-room-profile.mjs`, `server/mcp-discovery.mjs` — tool catalogs.

## Gotchas

- The "empty Bearer" carve-out means `Authorization: Bearer` (nothing after)
  is treated as anonymous — an MCP host config with an unset secret variable
  still gets the join tools instead of a 401.
- `legacyMcpHeaders` slices with `"Bearer ".length` after a case-insensitive
  test — `"bearer "` (lowercase, 7 chars) also matches the regex and the slice
  length is identical, so this is correct but subtle.
- Two parallel implementations (Fetch + Node) must be kept in sync by hand.

## Stale comments

None found — the #1528/#1529/QA5 references describe real behavior in the code.
