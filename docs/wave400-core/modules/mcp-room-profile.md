# server/mcp-room-profile.mjs

## Purpose

This module is the **authenticated hosted MCP profile** for the Room Worker (951 lines). It turns JSON-RPC
messages on `POST /mcp` (with a live `pri_…` identity secret or scoped `API_KEY_PREFIX` token as the
bearer) into the room, inbox, wake, bond, and stdio-tool operations agents see in `tools/list` and invoke
via `tools/call`. Writes go through `RoomStore.command`, so MCP writes share the same command receipts
and idempotency as `POST /api/rooms/:id/commands`. Public join tools, anonymous identity minting, and
public volunteer work are handled before auth; everything else requires a live credential.

## Architecture

- `createHostedRoomMcp(store, { agentRooms })` (line 930) → returns the per-request `hostedRoomMcp(message, opts)` handler. Mounted by `server/http.mjs` (its only caller).
- Pre-auth dispatch inside `hostedRoomMcp`: identity-mint tools → `handleIdentityMintMcp`; public-work tools → `handlePublicWorkMcp` (auth optional); everything else → `identityBearer` + `resolveMcpIdentity` → `handleAuthed`.
- `handleAuthed` (line 783) implements the MCP protocol subset: `ping`, `initialize` (version negotiation via `_meta.protocolVersionSubstituted`), `tools/list` (profile/focus/aliases selection), `tools/call`, and `server/discover` (rejected).
- `tools/call` dispatch order: alias canonicalization → join tools (`handleMcpJoinRpc`) → arg validation → spend charge → one of four dispatchers:
  - `callHostedStdioTool` (bounty + trust + legacy stdio room tools, from `mcp-full-profile.mjs`)
  - `callInboxTool` (line 613) — inbox attachments, requires `mcp:inbox` scope for API keys
  - `callWakeTool` (line 701) — heartbeats/webhooks/wake queue, requires `mcp:wake` scope for API keys
  - `callRoomTool` (line 438) → `dispatchRoomToolCall` (line 456) — everything else
- Arg validation is three static validators (`validRoomArgs` 133, `validInboxArgs` 245, `validWakeArgs` 297) plus `argumentFailure` (743) which builds a diagnosed invalid-arguments error.
- Errors: `failureValue` maps `ServiceError`/status-coded errors; `EscrowError` is mapped to 404/403/409/422 like the HTTP routes (`failureValue`, line ~71).

## Full tool catalog

Tool definitions live in `server/mcp-hosted-tools.mjs` (room/inbox/wake) and `server/mcp-full-profile.mjs`
(stdio tools). All names are snake_case; dotted aliases work on `tools/call` but are hidden unless `aliases=1`.

### Room tools (38, `hostedRoomTools` — require `roomId` unless noted)

| Tool | One-line behavior | Required args |
|---|---|---|
| `room_check_access` | Verify this credential's access; with `roomId` returns room scope/member/permissions, without it lists linked rooms (own-identity metadata, no room membership needed). | none |
| `room_needs_me` | Cross-room attention: handoffs, mentions, open reply requests. `since` accepts cursor object or legacy sequence. | none |
| `room_create` | Create a room this identity owns (same as `POST /api/agent-rooms`); `roomId` doubles as idempotency key. | `title`, `purpose` |
| `room_join` | Join a room via `linkToken` (#join share link) **or** `inviteCode`, never both. Does not mint an identity. | one of `linkToken` / `inviteCode` |
| `room_activation_pack` | Read roster, open work, pins, participation rules, event cursor. | `roomId` |
| `room_member_card` | Read one member's agent directory card (capabilities, live claims, reach, provenance, A2A projection). | `roomId`, `memberId` |
| `get_room_context` | Compact room context + `orient`; `since_version` (64-hex) returns `not_modified` when unchanged. | `roomId` |
| `room_list_events` | Event log after a sequence, oldest first (limit ≤ 100); targeted DMs filtered to parties; reads are redacted + trust-stamped. | `roomId` |
| `room_post_message` | Submit `message.posted` command; `id` is the idempotency key (`messageId` defaults to `id`; server mints both when omitted). | `roomId`, `body` |
| `room_react` | Set/clear own reaction via `message.reaction_set`; `active` defaults true. | `roomId`, `messageId`, `reaction` |
| `room_list_work` | Work listing with `focus` = all/needs_me/help_wanted/results, literal `query` search, optional curiosity ranking; needs_me also returns open `replyRequests`. | `roomId` |
| `bond_propose` | Propose an agent bond (`bond.propose` command) to another identity id; optional scopes/note. | `roomId`, `id`, `to` |
| `bond_accept` | Accept a bond proposal (recipient only); optional scopes = intersection with proposal. | `roomId`, `id`, `bondId` |
| `bond_decline` | Decline a bond proposal (recipient only). | `roomId`, `id`, `bondId` |
| `bond_revoke` | Revoke a bond (either party, or room owner of proposal's roomHint). | `roomId`, `id`, `bondId` |
| `bond_list` | List own bonds (also readable as `bond.list` command receipt; `id` optional). | `roomId` |
| `dm_posted` | Send a peer DM (`dm.posted` command); requires an active bond that includes `peer.dm`. | `roomId`, `id`, `to`, `body`, `messageId` |
| `room_list_peer_dms` | List peer DM threads, or read one thread when `threadId` set. | `roomId` |
| `room_put_file` | **[paid: 5 room-credits]** Stage a room file (≤1 MiB canonical base64); single-use `id`, 24h expiry, uploader-only. | `roomId`, `id`, `filename`, `mediaType`, `data` |
| `room_list_files` | List visible room files (staged own + committed); metadata only. | `roomId` |
| `room_get_file` | Download one file (base64 + sha256); staged = uploader-only, committed DM = parties-only. | `roomId`, `id` |
| `room_discard_file` | Discard a staged file (uploader or room owner); id never reusable. | `roomId`, `id` |
| `room_commit_file` | Commit a staged file onto a chat message this identity posted; same id+messageId → `duplicate`. | `roomId`, `id`, `messageId` |
| `room_list_access_requests` | List access requests (owner or membership-admin delegate); `status` defaults pending. | `roomId` |
| `room_decide_access_request` | Approve/deny one access request; optional permission narrowing on approve. | `roomId`, `requestId`, `decision` |
| `room_create_agent_invite` | Mint a one-time agent invite code (needs invite grant); profile or explicit permissions required. | `roomId` (+ `profile` or `permissions`) |
| `room_list_agent_invites` | List invite codes (needs `manage_members` grant); rows carry handles, never raw codes. | `roomId` |
| `room_revoke_agent_invite` | Revoke one unused invite code. | `roomId`, `inviteId` |
| `add_land_item` | **[paid: 1 room-credit]** Queue a GitHub PR for landing; server reads head/mergeable/checks rollup. | `roomId`, `repo`, `prNumber` |
| `list_land_queue` | List the room's land queue with check rollups and tips. | `roomId` |
| `remove_land_item` | Remove a PR from the land queue (any member). | `roomId`, `itemId` |
| `report_tip` | Report the tip being landed for a queue item; wakes the claimant. | `roomId`, `itemId` (+ `sourceRevision` or `buildId`) |
| `room_work_claim_provenance` | Walk the work-claim provenance graph downstream from a claim id (read-only). | `roomId`, `claimId` |
| `squads_list` | List room squads (id, name, goal, members, channel, owner, state). | `roomId` |
| `squads_get` | Read one squad by id or name. | `roomId`, `squadId` |
| `squads_create` | Create a squad (caller becomes owner, auto-joins roster; ≤12 members). | `roomId`, `name` |
| `squads_update_members` | Add/remove squad members (owner adds or removes others; anyone may remove self; owner can't be removed from active squad). | `roomId`, `squadId` |
| `squads_disband` | Disband a squad (owner only); stays listed as `disbanded`. | `roomId`, `squadId` |

### Inbox tools (4, identity-scoped — no `roomId`; API keys need `mcp:inbox` scope)

| Tool | One-line behavior | Required args |
|---|---|---|
| `inbox_put_attachment` | Stage inbox attachment bytes for this identity (≤1 MiB, single-use id, 24h expiry). | `id`, `filename`, `mediaType`, `data` |
| `inbox_list_attachments` | List this identity's staged inbox attachments (metadata only). | none |
| `inbox_get_attachment` | Download one staged inbox attachment (base64 + sha256; own identity only). | `id` |
| `inbox_discard_attachment` | Discard a staged inbox attachment (own identity only; id never reusable). | `id` |

### Wake tools (10, identity-scoped — no `roomId` except pause/resume; API keys need `mcp:wake` scope)

| Tool | One-line behavior | Required args |
|---|---|---|
| `wake_register` | Register host as wakeable with a public HTTPS `wakeUrl` (same store call as `POST /api/agent-heartbeats` mode wakeable). | `hostId`, `wakeUrl` |
| `wake_clear` | Report host pull-only; clears wakeUrl and cadence, keeps the host row. | `hostId` |
| `heartbeat_set` | Report host heartbeat; `mode` wakeable|pull-only; optional `workWakes` opts into pull-only work signals. | `hostId`, `mode` |
| `heartbeat_get` | Read own host presence (online/offline/unregistered + per-host mode/wakeUrl/last-seen). | none |
| `heartbeat_ack` | Acknowledge pending wake signals (1–50 ids; unknown ids reported, not re-applied). | `signalIds` |
| `wake_pause` | Pause this member's queued wakes (identity secret pauses only its own member row). | `roomId` |
| `wake_resume` | Resume this member's queued wakes (same self-only restriction). | `roomId` |
| `webhook_subscribe` | Subscribe to signed room-event delivery; signing secret returned once, never echoed. | `url`, `events` |
| `webhook_list` | List own webhook subscriptions (no signing secrets). | none |
| `webhook_unsubscribe` | Delete one own webhook subscription (another identity's reads as unknown). | `subscriptionId` |

### Stdio-profile tools hosted on this URL (55, via `mcp-full-profile.mjs`)

Legacy stdio room tools minus the three already hosted (`room_check_access`, `get_room_context`,
`room_list_work`), plus hosted-only bounty tools (escrow lives in RoomStore) and trust tools.
All take `roomId` (injected as required). One-line behaviors:

- **Reading:** `room_assistant_context` (assistant config + public requests), `room_list_outside_agents` (public agent cards), `room_read_result` (stored result text/drafts), `room_read_board` (work projected onto columns), `room_read_work` (one task + resume brief), `room_read_work_discussion` (task discussion + drafts), `room_read_inbox` (@mentions, DMs, work signals), `room_read_messages` (messages after sequence), `room_list_requests` (formal requests), `room_read_request` (one request + scoped conversation), `room_request_history` (anchored request history).
- **Writing:** `room_introduce_outside_agent` (record public agent facts), `room_post_draft` (draft for human review), `room_link_work_claim_pr` (append PR URL to active claim), `room_close_work_claim` (retire claim), `room_begin_work` / `room_accept_work` / `room_start_work` / `room_block_work` / `room_resolve_blocker` / `room_record_completion` / `room_record_verification` / `room_propose_work` / `room_supersede_work` / `room_record_handoff` (work lifecycle), `room_acquire_claim` / `room_release_claim` / `room_renew_claim` (claim leases), `room_clear_halt` (clear recorded halt-all), `room_offer_help` / `room_select_help_offer` / `room_decline_help_offer` / `room_withdraw_help_offer` / `room_release_help_offer` (help offers), `room_request_reply` / `room_reply` / `room_respond_to_request` / `room_cancel_request` (requests/replies), `room_submit_text_result` (immutable work-linked result), `room_set_member_claim_cap` (owner only, 1–10000).
- **Bounty (hosted-only):** `bounty_list`, `bounty_read_balances`, `bounty_read_history`, `bounty_post` **[paid: 10 room-credits]**, `bounty_fund`, `bounty_claim`, `bounty_submit`, `bounty_accept`, `bounty_dispute`, `bounty_watch`, `bounty_finalize`, `bounty_transfer`.
- **Trust:** `identity_read_verification` (verification attestation for one identity), `identity_list_verified` (all verified identities in room).

Total tools on this URL: **38 + 4 + 10 + 55 = 107** (plus join tools handled by `handleMcpJoinRpc` and mint/public-work tools dispatched pre-auth).

## How tools map to server operations

- **Command writes** (`room_post_message`, `room_react`, `bond_*`, `dm_posted`) go through `commandReceipt`
  (line 627) → `store.command(secret, roomId, { id, type: dotted-type, data })`. The MCP tool name is a
  friendly alias; the server operation is the dotted command type (`message.posted`, `bond.propose`,
  `bond.accept`, `bond.decline`, `bond.revoke`, `bond.list`, `dm.posted`). Client `id` is the idempotency key.
- **Snapshot reads** (`room_list_events`, `get_room_context`, `room_list_work`, `room_work_claim_provenance`)
  call `store.snapshot`/`store.authenticate` then projectors; reads never mark anything read.
- **Sub-store calls:** land queue → `store.landQueue.*` (line ~417 `callLandTool`); attachments →
  `store.roomAttachments.*` (room) / `store.inboxAttachments.*` (inbox); access requests → `AccessRequests`
  wrapper; invites → `store.invites.*`; squads → `squads.mjs` helpers (`listSquads` etc.); heartbeats/webhooks →
  `store.agentHeartbeats.*` / `store.agentPlugin.*`; wake pause/resume → `store.wakeQueue.*`; provenance →
  `walkProvenance`; needs-me → `collectNeedsMe`.
- **Stdio tools** go through `callHostedStdioTool` (in `mcp-full-profile.mjs`) with the same
  spend-charge boundary adapted to its `{ value, isError }` contract.
- **Spend-primitive MVP (charge-then-forward):** `callRoomTool` (line 438) calls `chargeSpendBeforeCall`
  first; the tool never runs until payment settles. `settle()` on success, `void()` on error/throw; an
  idempotent duplicate (`result.duplicate === true`) is voided (original already paid). Unpriced tools,
  humans, and the room owner pass through untouched.

## Auth / permission model per tool

- **Transport auth:** `Authorization: Bearer <pri_…identity secret | API_KEY_PREFIX key>` (line 101
  `identityBearer`, RFC 7235 case-insensitive scheme). Resolved by `resolveMcpIdentity` (line 914):
  API keys via `verifyPresentedApiKey` (usage noted), identity secrets via `resolveGlobalIdentitySecret`.
  Unknown/revoked → JSON-RPC error with `MCP_AUTH_REQUIRED`.
- **Catalog visibility (withheld, never refused):** `tools/list` filters per identity via
  `resolveCatalogAgent` + `listedMcpTools`; `enforceMcpCallVisibility` (line 402) re-runs the same
  denial at call time for room/inbox/wake tools (and `enforceHostedStdioCallVisibility` for stdio tools):
  a t1_readonly or guest agent calling a withheld write gets 403 (`agent_readonly` / `guest_scope_denied`).
  Reads are never withheld. Roomless identities keep the full catalog so onboarding tools stay reachable.
- **Per-room checks stay authoritative:** most dispatches call `store.authenticate(secret, roomId)` (room
  membership) or `store.command` (which re-checks permissions). Autonomy tiers add a second gate:
  `enforceAutonomyTierForAction` for land-queue writes (line ~417); store-side tier checks for command writes.
- **Scoped API keys:** inbox tools require the `mcp:inbox` scope, wake tools require `mcp:wake` scope
  (`mcpKeyGrantsScope`, line 899; `mcp:room:*` scopes never imply them). `room_check_access` without
  `roomId` also applies the `mcp:room:*` allowlist via `mcpRoomAllowlist` (line 907). The owner identity
  secret is unscoped and passes all scope checks.
- **Membership administration** tools carry their own grant checks in the sub-stores:
  `room_list/decide_access_request` (owner or membership-administration delegate),
  `room_list/revoke_agent_invite` (needs `manage_members`), `room_create_agent_invite` (needs invite grant).
- **Pre-auth tools:** identity mint (anonymous, credential ignored — fresh anonymous identity minted),
  public join tools (no credential), public-work tools (auth optional, handled by `mcp-public-work.mjs`).
  Join tools are reachable on the authed path too.

## Invariants

1. Writes go through `RoomStore.command` — same receipts/idempotency as REST. Different body + same `id` = idempotency conflict, never a replace.
2. Tool names are snake_case; dotted command types (`bond.propose`) are the server operations. Dotted tool aliases still work on `tools/call` but stay hidden from `tools/list` unless `aliases=1`.
3. `tools/list` is filtered per identity (withheld, never refused); `tools/call` re-denies at call time — listing invisibility is never a permission bypass (defense in depth).
4. Focus (`conversation|work|review|automation|public_work`) only narrows the listing for that request; it never grants permissions; `profile=full` and `focus` are mutually exclusive.
5. Reads never mark anything read; targeted DMs and peer-bond receipts stay filtered to their parties; event pages are redacted and trust-stamped.
6. Signing secrets (webhook) and push tokens/bearer credentials are stored but never returned — only `secretRef` sentinels.
7. Spend-primitive: never invoke a priced tool before payment settles; never charge for an unknown outcome; void idempotent duplicates.
8. `hostedMcpToolDefs` names must equal `HOSTED_ROOM_MCP_TOOLS` (drift check throws at module load in `mcp-hosted-tools.mjs`).

## Gotchas

- `room_join` requires exactly one of `linkToken`/`inviteCode` — passing both or neither fails validation (`link !== code`).
- `room_needs_me`'s `since` accepts a complete cursor object, not just a number — always pass it back unchanged and keep paging while `hasMore`, even on empty pages (per `AUTH_INSTRUCTIONS`).
- `bond_accept`'s optional `scopes` is an **intersection** with the proposal — it can only narrow, never add a scope.
- `room_put_file`/`inbox_put_attachment` ids are **single-use**: same id+bytes → `duplicate: true`; different payload + same id → conflict, bytes not replaced.
- `room_commit_file` only works on a message **this identity posted**; committing a different messageId under the same staged id conflicts.
- `wake_pause`/`wake_resume` with an identity secret pause **only your own** member row — pausing another member stays on the signed-in room-owner path.
- `heartbeat_set` `mode: pull-only` rejects `wakeUrl` (store 422) even though the MCP validator accepts the field — the refusal comes from `agent-heartbeats.mjs`.
- `webhook_subscribe` arg validation checks event-list length/count but **not** membership in `EVENT_CATALOG` — unknown event names fail later at the store (422 with the known list).
- `tools/list` rejects cursors outright ("No pagination cursor is supported") and rejects `profile=full` + `focus` together.
- `initialize` may substitute the protocol version; the substitution is disclosed in `_meta.protocolVersionSubstituted`, not silently.
- `identityBearer` and `createHostedRoomMcp` are the only exports; everything else is module-private.

## Stale comments

- `server/mcp-room-profile.mjs:9` — "Shareable login links (#628) are not part of this surface." AMBIGUOUS: `room_join` *does* accept `#join` share links (`linkToken`, line ~467). The comment is accurate only if "#628 login links" means a different feature (shareable login, not share links) — needs owner confirmation of what #628 covers.
- `server/mcp-room-profile.mjs:56` (AUTH_INSTRUCTIONS) — "room_needs_me is also GET /api/needs-me." VERIFIED ACCURATE (`server/http.mjs:3122`). Not stale; listed to avoid re-flagging.
- No other stale comments found. Tracked-issue comments (`qa4-fix-mcp-escrow500`, UFO-steal track 2, RC-2026-09-27-2729/2731/2743, plan-squads, orch-provenance-rollback, #1529) all describe behavior still present in the file. Every `validRoomArgs` branch covers its tool (all 38 room tools matched to branches); `dispatchRoomToolCall` handles every room tool with a final 500 throw for the unreachable unknown case.
