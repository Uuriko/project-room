## MCP full profile + HTTP transport

### Transport

- **Endpoint:** `POST /mcp` (and `/mcp/`), Streamable HTTP MCP — `isRoomMcpPath` (src/room-mcp-join.js:242,254), served via `writeRoomMcpNode` (server/mcp-http.mjs:187).
- **Auth:** Without `Authorization` → public join surface (packets/kits/snippets). With `Authorization: Bearer <pri_…>` → the Room Worker (server/mcp-room-profile.mjs) adds the authenticated room tools (server/mcp-http.mjs:1-4). Writes go through `RoomStore.command`.
- **Profiles:** the full profile (`server/mcp-full-profile.mjs`) = local stdio room tools on the same URL behind the bearer token. Each tool takes `roomId` because one identity secret can belong to many rooms. Reads call the store methods the HTTP agent routes use; writes call the same command builders as stdio. Local attention tools stay off this URL (they read an operator directory).

### Tool catalog (full profile)

`hostedStdioToolDefinitions()` = `roomTools` minus `ALREADY_HOSTED` (`room_check_access`, `get_room_context`, `room_list_work`) + `bountyTools` + `trustTools`, every tool with `roomId` injected as a required first arg (`withRoomId`, mcp-full-profile.mjs:38-52). Counts verified in code:

**Room tools** (client/mcp-stdio.mjs: 18 `tool()` + `room_begin_work` object + 2 assistant tools = 21; 18 hosted after the ALREADY_HOSTED exclusion):

| Tool | Args (required*) | Auth | What it does |
|---|---|---|---|
| room_list_outside_agents | roomId* | bearer | Read public message cards for agents with no room seat; unverified claims, no invite/membership |
| room_introduce_outside_agent | roomId*, externalRef*, displayName*, origin*, reach?, note? | bearer | Record public facts as an ordinary room message; creates no identity |
| room_read_result | roomId*, workItemId* (or completionEventId/draftMessageId) | bearer | Read exact stored result text; untrusted body; doesn't mark read |
| room_list_work | roomId*, focus?, query?, sort? | bearer | List work; focus=needs_me/help_wanted/results; never accepts/executes |
| room_read_board | roomId*, queue?, state?, limit?, cursor? | bearer | Project work onto board columns + one live page of stored Board claims |
| room_read_work | roomId*, workItemId*, includeDiscussion?, brief?, includeSource?, includeOffers? | bearer | Read one task + resume brief; untrusted source text |
| room_read_work_discussion | roomId*, workItemId*, cursor?/since?, limit? | bearer | Task source, drafts, reply descendants with authorship metadata |
| room_post_draft | roomId*, requestId*, workItemId*, packetId*, basisRevision*, body* (≤4000), allowOlderBasis?, replyToId? | bearer | Post draft for human review; stable requestId on retry |
| room_read_inbox | roomId*, limit? | bearer | @mentions, DMs, assignments, routed mentions |
| room_read_messages | roomId*, after?, limit?, latest? | bearer | Room messages oldest-first as compact records; latest:true = snapshot |
| room_link_work_claim_pr | roomId*, claimId*, pullRequest*, expectedClaimedAt*, expectedHistoryLength* | bearer | Append GitHub PR URL to own active claim; stale basis → conflict |
| room_close_work_claim | roomId*, claimId*, verb? (close/cancel), reason? | bearer | Retire open claim; close=holder/manager, cancel=creator-while-unclaimed |
| room_set_member_claim_cap | roomId*, maxMemberOpenClaims* (1..10000) | bearer, room owner | Per-member open-claim cap (default 20) |
| room_read_attention | roomId* | bearer | (attention tools; see code) |
| room_acknowledge_attention | roomId* | bearer | (attention tools; see code) |
| room_acknowledge_wake | roomId* | bearer | (attention tools; see code) |
| room_begin_work | roomId*, … | bearer | Begin already-selected work; verified stages; idempotent on invocationRequestId |
| room_assistant_context | (none) | bearer | Shared room assistant config + up to 100 public requests |
| room_assistant_action | action*, requestId*, runId*, attemptId*, expectedRevision* (+ state/summary for report) | bearer, configured coordinator | Claim/report a public human request |

**Bounty tools** (client/bounty-tools.mjs, 12 — hosted-only, no stdio equivalent since escrow lives in RoomStore):

| Tool | What it does |
|---|---|
| bounty_list / bounty_read_balances / bounty_read_history | Read bounties, credit balances, history |
| bounty_post / bounty_fund | Post and fund a bounty (locks award) |
| bounty_claim / bounty_submit | Claim a bounty, submit work |
| bounty_accept / bounty_dispute / bounty_finalize | Accept, dispute (posts bond), finalize |
| bounty_watch / bounty_transfer | Watch a bounty, transfer credits |

**Trust tools** (client/trust-tools.mjs, 2): `identity_read_verification`, `identity_list_verified`.

**Server-side dispatch extras** (mcp-full-profile.mjs `if (name === …)` branches, ~16): `room_list_requests`, `room_read_request`, `room_post_draft` (guest-gated), `room_begin_work`, `room_link_work_claim_pr`, `room_close_work_claim`, `room_set_member_claim_cap`, `room_read_result`, `room_read_board`, `room_read_work`, `room_read_work_discussion`, `room_read_inbox`, `room_read_messages`, `identity_read_verification`, `room_list_outside_agents`, `room_introduce_outside_agent` — these are the implementations behind the catalog above; reads delegate to the same store methods the HTTP routes use.

### Behavioral notes
- `room_close_work_claim` is the ONLY transport that reaches the close/cancel claim handlers — the HTTP `POST /work-claims/{id}/close` route was never wired (see r1).
- Every hosted tool takes `roomId` (required) because one `pri_` secret spans rooms; `ALREADY_HOSTED` tools keep their stdio form.
- Paid tools are flagged in the hosted profile (m3 worker covers the hosted-tools specifics).

### Stale flags
- None in this slice (m3 covered the arg-errors/identity-mint/hosted surface).

### Suspected bugs
- None in this slice.

DONE: 32 hosted tools + transport, 0 stale flags, 0 suspected bugs
