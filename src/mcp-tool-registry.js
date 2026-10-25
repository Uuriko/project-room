// MCP tool registry — the single metadata source for catalog selection.
//
// Before this module, a tool's catalog identity was hand-declared in up to
// seven places (def, HOSTED name list, core list, blurbs, contracts, focus
// lists, visibility sets, aliases — see simplify-s4-mcp.md §4). This table is
// step 1 of the registry consolidation (EXECUTION-BRIEF decision #14): the
// selection metadata that used to live as separate hand lists in
// src/room-mcp-join.js (CORE_MCP_TOOLS, CORE_MCP_BLURBS, MCP_TOOL_ALIASES)
// and server/mcp-discovery.mjs (MCP_TOOL_FOCUSES, FOCUS_COMMON_TOOLS) is now
// declared ONCE, here, as fields on the tool's entry. Those modules derive
// their exports from this table; catalog output is unchanged.
//
// Entry fields:
//   name  — canonical snake_case tool name (must exist in the hosted defs;
//           the startup checks in src/room-mcp-join.js police this).
//   core  — listed in the default Bearer tools/list profile.
//   blurb — short description served on the core/lean profiles instead of
//           the def's full description (byte budget: tests/mcp-core-profile).
//   alias — legacy dotted tools/call name, hidden from tools/list unless
//           aliases=1. MCP_TOOL_ALIASES is the inverted view of this field.
//   focus — discovery views the tool belongs to; "common" is the set every
//           focus view includes. Focus membership is a set: listing order
//           comes from the defs, never from this field.
//
// Tools with no selection metadata (full-profile only) have no entry.
// Order: core tools first, in core listing order (CORE_MCP_TOOLS derives by
// filtering this table, so core entry order IS the core catalog order);
// the rest follow HOSTED_ROOM_MCP_TOOLS order.
export const MCP_TOOL_META = Object.freeze([
  { name: "room_needs_me", core: true, blurb: "Cross-room attention and messages. Pass the complete cursor as since; continue while hasMore, even on an empty page. Discovery is not resolution.", focus: ["common"] },
  { name: "room_read_messages", core: true, blurb: "Read room messages oldest first. latest:true returns the newest messages. Pass roomId.", focus: ["conversation"] },
  { name: "room_post_message", core: true, blurb: "Post a room message. Optional replyToId.", focus: ["common"] },
  { name: "room_reply", core: true, blurb: "Reply under a room message. Pass roomId, replyToId, and body. Ordinary replies do not close formal requests.", focus: ["common"] },
  { name: "room_list_requests", core: true, blurb: "List formal requests by direction and status (defaults incoming/open). Follow nextReads and finish selected context before responding. Reads do not close requests.", focus: ["common"] },
  { name: "room_read_request", core: true, blurb: "Read a formal request addressed to or sent by you. Pass roomId and requestMessageId. Finish every page before using responseActions; incomplete or stale context cannot authorize an answer.", focus: ["common"] },
  { name: "room_respond_to_request", core: true, blurb: "Answer or decline a formal request addressed to you. Use the complete selected read's responseActions, add requestId and body, preserve all fixed arguments. Retry unchanged after an unknown result; follow next to verify current status.", focus: ["common"] },
  { name: "dm_posted", core: true, blurb: "Send a peer DM. Requires an active bond that includes peer.dm. Pass roomId, to, body, and messageId.", alias: "dm.posted", focus: ["conversation"] },
  { name: "room_check_access", core: true, blurb: "List rooms this identity is in. Pass roomId to check one room.", focus: ["common"] },
  { name: "room_create", core: true, blurb: "Create a room you own. Pass title and purpose. Invite peers at POST /api/rooms/{roomId}/agent-invites." },
  { name: "room_join", core: true, blurb: "Join a room with a share-link token or an invite code." },
  { name: "room_put_file", core: true, blurb: "Upload a room file as canonical base64 (at most 1 MiB). Then room_commit_file.", focus: ["work"] },
  { name: "room_commit_file", core: true, blurb: "Commit a staged file onto a message you posted. Pass roomId, id, and messageId.", focus: ["work"] },
  { name: "add_land_item", core: true, blurb: "Add a pull request to this room's land queue. Pass roomId, repo (owner/name), and prNumber." },
  { name: "list_land_queue", core: true, blurb: "List this room's land queue.", focus: ["review"] },
  { name: "wake_pause", core: true, blurb: "Pause your queued wakes in this room.", alias: "wake.pause", focus: ["automation"] },
  { name: "wake_resume", core: true, blurb: "Resume your queued wakes in this room.", alias: "wake.resume", focus: ["automation"] },
  { name: "bond_propose", core: true, blurb: "Request a bond. Pass roomId and to. They answer with bond_accept; then peer.dm opens.", alias: "bond.propose" },
  { name: "get_room_context", focus: ["common"] },
  { name: "room_list_work", focus: ["work", "review"] },
  { name: "bond_accept", alias: "bond.accept", focus: ["conversation"] },
  { name: "bond_decline", alias: "bond.decline", focus: ["conversation"] },
  { name: "bond_revoke", alias: "bond.revoke", focus: ["conversation"] },
  { name: "bond_list", alias: "bond.list", focus: ["conversation"] },
  { name: "room_list_peer_dms", focus: ["conversation"] },
  { name: "room_list_files", focus: ["work", "review"] },
  { name: "room_get_file", focus: ["work", "review"] },
  { name: "room_work_claim_provenance", focus: ["work"] },
  { name: "wake_register", alias: "wake.register", focus: ["automation"] },
  { name: "wake_clear", alias: "wake.clear", focus: ["automation"] },
  { name: "heartbeat_set", alias: "heartbeat.set", focus: ["automation"] },
  { name: "heartbeat_get", alias: "heartbeat.get", focus: ["automation"] },
  { name: "heartbeat_ack", alias: "heartbeat.ack", focus: ["automation"] },
  { name: "webhook_subscribe", alias: "webhook.subscribe", focus: ["automation"] },
  { name: "webhook_list", alias: "webhook.list", focus: ["automation"] },
  { name: "webhook_unsubscribe", alias: "webhook.unsubscribe", focus: ["automation"] },
  { name: "room_assistant_context", focus: ["common"] },
  { name: "room_assistant_action", focus: ["work"] },
  { name: "room_read_result", focus: ["work", "review"] },
  { name: "room_read_work", focus: ["work", "review"] },
  { name: "room_read_work_discussion", focus: ["work", "review"] },
  { name: "room_post_draft", focus: ["work"] },
  { name: "room_read_inbox", focus: ["conversation"] },
  { name: "room_link_work_claim_pr", focus: ["work"] },
  { name: "room_begin_work", focus: ["work"] },
  { name: "room_submit_text_result", focus: ["work"] },
  { name: "room_propose_work", focus: ["work"] },
  { name: "room_accept_work", focus: ["work"] },
  { name: "room_start_work", focus: ["work"] },
  { name: "room_block_work", focus: ["work"] },
  { name: "room_resolve_blocker", focus: ["work"] },
  { name: "room_record_completion", focus: ["work"] },
  { name: "room_record_verification", focus: ["review"] },
  { name: "room_acquire_claim", focus: ["work"] },
  { name: "room_release_claim", focus: ["work"] },
  { name: "room_renew_claim", focus: ["work"] },
  { name: "room_record_handoff", focus: ["work"] },
  { name: "room_request_history", focus: ["conversation"] },
  { name: "room_request_reply", focus: ["common"] },
  { name: "room_cancel_request", focus: ["conversation"] }
]);

