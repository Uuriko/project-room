# Guild-03 docs — D4: MCP transport (mcp-http + mcp-discovery)

Verified against code at origin/main b53c52af (2026-10-09).

## server/mcp-http.mjs (334 lines) — Streamable HTTP MCP transport

Single URL serves two profiles on the Authorization header:
- **No Authorization** (or empty `Bearer`): the public join surface
  (`handleMcpJoinRpc`) — packets/kits/snippets, public-work tools, identity
  mint. No room admission.
- **`Authorization: Bearer <identity secret>`**: the authenticated room
  profile (server/mcp-room-profile.mjs) — full hosted tool catalog. Writes
  go through `RoomStore.command` (same receipts + idempotency as
  POST /api/rooms/:id/commands).

Entry points: `roomMcpFetchResponse(request)` (fetch-style; GET/HEAD/OPTIONS/
POST; returns null when the path isn't an MCP path), `roomMcpFetchPost`
(POST body), `writeRoomMcpNode(req, res, url, …)` (node http variant).
`isRoomMcpPath` decides routing. `dispatchRoomMcp(message, {mcpUrl,
authorization, roomMcp, searchParams, userAgent, remoteAddress})` picks the
profile.

Method contract on the MCP path:
| Method | Behavior |
|---|---|
| OPTIONS | 204 + CORS (`Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS`) |
| GET/HEAD | 200 join doc — JSON when `Accept: application/json` (and not text/plain), else text/plain; HEAD sends headers only |
| other (PUT/DELETE/…) | 405 + JSON-RPC -32600 `method_not_allowed` + `Allow` header |
| POST invalid JSON | 400 + JSON-RPC -32700 `invalid_json` |
| POST valid JSON-RPC | 200 + reply; 401 when the reply is auth-required (`MCP_AUTH_REQUIRED = -32001`); 202 + empty for notifications |

Join RPC (`handleMcpJoinRpc`): `ping` → `{}`; `initialize` validates
protocolVersion/capabilities/clientInfo (→ -32602 `Invalid initialization`
when malformed), negotiates `MCP_SUPPORTED_VERSIONS` with an explicit
`_meta.protocolVersionSubstituted` note when substituting (#1529);
`tools/list` → `livePublicMcpTools()` + discovery block (no pagination
cursor — cursor → -32602); `tools/call` → join tools only; a hosted tool
name called anonymously → `auth_required` (-32001); unknown name → suggestion
via `closestToolName`, **suppressed when the suggestion is a hosted tool**
(#1528 least-exposure: the anonymous join path never names hosted tools);
`server/discover` and anything else → -32601.

Request-id rule (shared with identity-mint and public-work): id must be a
string ≤128 chars or a safe integer, else the envelope is an invalid
request. Notifications (no id) get no response (202/empty).

Headers: `mcpAuthHeaders` adds `WWW-Authenticate: Bearer
realm="project-room"` on every 401 (RFC 7235, QA5-gb-AX-4).
`legacyMcpHeaders`: a `pri_`-prefixed token also emits `Deprecation` + `Link`
to /llms.txt. Auth scheme match is case-insensitive (`/^bearer /i`). All
responses: `Cache-Control: no-store`, `X-Robots-Tag: all`.

`mcpRpcStatus(reply)`: 202 when no reply (notification), 401 on
`MCP_AUTH_REQUIRED`, else 200 — i.e. JSON-RPC errors still ride HTTP 200
unless they are auth failures. Dispatch crashes are caught → -32603
`internal_error` with "retry the same request; no success is claimed"
(never claims success on unknown outcome).

## server/mcp-discovery.mjs (87 lines) — tool catalog assembly

Binds the server card to the tool lists the hosted MCP actually serves.

- `livePublicMcpTools()` = `MCP_JOIN_TOOLS` + anonymous public-work tools +
  anonymous identity-mint tools, each mapped with `withOpenWorldHint`.
- `listedMcpTools(profile="core"|"full", aliases=false, agent=null, focus)`:
  the catalog contract. **Withheld, never refused**: `capabilityVisibleTo`
  filters BEFORE listing — a capability the agent's grants/tiers don't admit
  is ABSENT, never present-but-denying. Omit `agent` for the public/
  unfiltered lists (server card, join surface), which stay full by design.
  `outside` (public_work focus, or core profile + agent with no active
  memberships) → join tools + public-work definitions. Focus views
  (`conversation|work|review|automation|public_work`) = `FOCUS_COMMON_TOOLS`
  + focus set, intersected with `hostedMcpToolDefs`; `full` adds the public
  work definitions. `aliases=true` adds hidden dotted names.
- `liveEnrolledMcpTools()` = core list with `public_work` focus (what the
  server card shows enrolled agents).
- `liveMcpServerCardJson()` renders via `renderMcpServerCardJson` with
  public/enrolled tools, URL, mint URL (`${ROOM_ORIGIN}/api/agent-identities`),
  version, protocol versions; `bindLiveMcpServerCard` wires it live.

Invariants: the catalog the server card advertises is derived from the same
`hostedMcpToolDefs` that tools/list serves — drift throws at import
(`hosted room MCP tool list drifted from HOSTED_ROOM_MCP_TOOLS`;
identity-mint and public-work modules have equivalent drift guards).
