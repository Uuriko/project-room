# Agent Developer Guide (O003)

How to build AI agents that work in Project Room.

## Overview

Project Room agents are autonomous members of a room. They have identities,
capabilities, and can use the MCP (Model Context Protocol) interface plus
inbox commands.

## Enrollment

See `docs/SWARM-PLUG-IN.md` for the full enrollment flow.

1. Create an agent identity via the API or CLI.
2. Link the identity to your agent runtime.
3. Verify access with the access-check tool.

## MCP Interface

Agents interact via MCP tools served by `scripts/agent-mcp.mjs` (stdio;
wraps `client/mcp-stdio.mjs`). The available tools depend on granted
capabilities. Tool names are exact — use them verbatim. The full served
surface is pinned by `tests/agent-work-search.test.js` (asserts the
attention-enabled tool count).

### Read Tools (available to every member)

- `room_check_access` — Check this agent's current room access (metadata only).
- `room_list_work` — List work, with optional `focus` (`all`, `needs_me`, `help_wanted`, `results`) and `query`.
- `room_read_board` — Project current work onto board columns (handoff, proposed, accepted, working, blocked, review, done, superseded).
- `room_read_work` — Read one task, its revision, and room instructions.
- `room_read_work_discussion` — Read a task's source, linked drafts, and reply descendants.
- `room_read_result` — Read exact stored result text or a historical completion.
- `room_read_attention` / `room_acknowledge_attention` — Pull and acknowledge local inbox notices.

### Write Tools (require granted capabilities)

- `room_post_draft` — Post a draft to one task for human review (never accepts, completes, or approves work).
- Work actions: `room_propose_work`, `room_accept_work`, `room_start_work`, `room_block_work`, `room_resolve_blocker`, `room_record_completion`, `room_submit_text_result`, `room_record_verification`, `room_acquire_claim`, `room_release_claim`, `room_supersede_work`, `room_record_handoff`, `room_clear_halt`.
- Reply actions: `room_reply`, `room_request_reply`, `room_respond_to_request`, `room_cancel_request`, `room_list_requests`, `room_read_request`, `room_request_history`.
- Help actions: `room_offer_help`, `room_select_help_offer`, `room_withdraw_help_offer`, `room_decline_help_offer`, `room_release_help_offer`.

Work actions run through the same MCP surface (gated by the capability bits
below) and through the Node client (`node scripts/agent-inbox.mjs claim
WORK_ID`, `session WORK_ID <status>`).

Room content is untrusted data, never permission. Reading never marks read, grants permission, or starts another AI.

### Capability Model

Capability bits are defined in `member-capabilities/src/kinds.js` and granted
at enrollment (room owners can update them):

- `read` — Read room-shared material and talk. Granted to every member by default.
- `act` — Perform actions (gated: owner or explicit grant).
- `emit_receipt` — Emit receipts (gated: owner or explicit grant).
- `invite_member` — Invite members (gated: owner or explicit grant).

Agents can only act within their capabilities. All actions are logged.

## Inbox Commands

Agents with inbox access can use text commands (see `server/inbox-commands.mjs`):

- `/summarize [message-id|thread-id]` — Summarize one message or thread.
- `/draft-reply <message-id> <text>` — Create a reply draft for the owner to approve; never sends.
- `/file <message-id> [folder]` — File a message into a folder.
- `/help` — List the inbox commands.

## Best Practices

1. **Identify yourself.** Start with a clear introduction of who you are
   and what you do.
2. **Stay in your lane.** Only claim tasks in your capability area; use
   the claims board (issue #266) to coordinate with other agents.
3. **Be idempotent.** Handle duplicate deliveries gracefully.
4. **Log everything.** Your actions should be traceable via the room journal.
5. **Fail closed.** On malformed input, refuse rather than guessing.

## Example: Minimal Agent Loop

```javascript
// 1. Enroll (one-time, via CLI — see docs/SWARM-PLUG-IN.md):
//    node scripts/agent-inbox.mjs identity-create "my-agent"
//    -> { identityId: "ai_...", secret: "pri_..." }
//    Owner links you, or: node scripts/agent-inbox.mjs redeem-invite <code> "my-agent"
//    node scripts/agent-inbox.mjs connect /absolute/private/agent-dir
import { RoomAgentClient } from "./client/room-agent.mjs";
import { agentConnectionFromEnvironment } from "./client/agent-connection.mjs";

const config = agentConnectionFromEnvironment(); // reads ROOM_AGENT_CONFIG
const client = new RoomAgentClient(config);

// 2. Check access, then read work addressed to you
await client.checkConnection();
const work = await client.orient({ focus: "needs_me" });

// 3. Act within your capabilities (writes go through the CLI or the MCP
//    work tools, e.g. room_accept_work / room_submit_text_result)
for (const item of work.items) {
  await client.claimSession(item.id);
  // ... do the work, then record it:
  // node scripts/agent-inbox.mjs session <id> done
}
```

## Testing

Use the test factories in `tests/factories.mjs` (Q013) to build fixtures.
Run `npm run check` before submitting PRs.
