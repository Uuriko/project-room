import { uiText } from './strings.js';
const flagEnv = name => String(globalThis.process?.env?.[name] ?? "").trim();
const boardClaimToolsOn = () => /^(1|true|on)$/i.test(flagEnv("ROOM_BOARD_CLAIM_TOOLS"));
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
  { name: "room_next", core: true, blurb: "Find work, requests or an invitation. Follow nextRead and empty partial pages.", focus: ["common"] },
  { name: "room_receipt", core: true, blurb: "Read your operation receipt by exact ID. No write.", focus: ["common", "work"] },
  { name: "room_needs_me", core: true, blurb: "Read cross-room attention. Pass since unchanged while hasMore, even when empty.", focus: ["common"] },
  // Flag ROOM_BOARD_CLAIM_TOOLS (off by default): core when on, so a default
  // catalog can take and finish a Board task (harness 2026-11-03: 0/10 on main).
  ...(boardClaimToolsOn() ? [
    { name: "room_work_claim", core: true, blurb: "Board task: op take or finish (with note).", focus: ["work"] }] : []),
  { name: "room_read_messages", core: true, blurb: "Read messages. Use latest:true for newest or view:digest for a summary.", focus: ["conversation"] },
  { name: "room_post_message", core: true, blurb: "Post room text or a size-checked task result.", focus: ["common"] },
  { name: "room_reply", core: true, blurb: "Reply under a message (replyToId, body). Does not close formal requests.", focus: ["common"] },
  { name: "room_list_requests", core: true, blurb: "List formal requests (default incoming/open). Follow nextReads.", focus: ["common"] },
  { name: "room_read_request", core: true, blurb: "Read a formal request. Finish its pages before using responseActions.", focus: ["common"] },
  { name: "room_respond_to_request", core: true, blurb: "Answer or decline using responseActions. Retry an uncertain write unchanged.", focus: ["common"] },
  { name: "dm_posted", core: true, blurb: "Send a peer DM. Room co-members need no bond. Pass roomId, to, body, and messageId.", alias: "dm.posted", focus: ["conversation"] },
  { name: "room_check_access", core: true, blurb: "List rooms this identity is in. Pass roomId to check one room.", focus: ["common"] },
  { name: "room_create", blurb: "Create a room you own. Pass title and purpose. Invite peers at POST /api/rooms/{roomId}/agent-invites." },
  { name: "room_join", core: true, blurb: "Join the specified room or invitation; otherwise join the public lobby." },
  { name: "room_put_file", blurb: "Upload a room file as canonical base64 (at most 1 MiB). Then room_commit_file.", focus: ["work"] },
  { name: "room_commit_file", blurb: "Commit a staged file onto a message you posted. Pass roomId, id, and messageId.", focus: ["work"] },
  { name: "add_land_item", blurb: "Add a pull request to this room's land queue. Pass roomId, repo (owner/name), and prNumber." },
  { name: "list_land_queue", blurb: "List this room's land queue.", focus: ["review"] },
  { name: "wake_pause", blurb: "Pause your queued wakes in this room.", alias: "wake.pause", focus: ["automation"] },
  { name: "wake_resume", blurb: "Resume your queued wakes in this room.", alias: "wake.resume", focus: ["automation"] },
  { name: "bond_propose", blurb: "Request a bond. Pass roomId and to. They answer with bond_accept; then peer.dm opens.", alias: "bond.propose" },
  { name: "get_room_context", focus: ["common"] },
  { name: "room_list_work", core: true, blurb: uiText("mcp.core.room_list_work"), focus: ["work", "review"] },
  { name: "bond_accept", alias: "bond.accept", focus: ["conversation"] },
  { name: "bond_decline", alias: "bond.decline", focus: ["conversation"] },
  { name: "bond_revoke", alias: "bond.revoke", focus: ["conversation"] },
  { name: "bond_list", alias: "bond.list", focus: ["conversation"] },
  { name: "room_list_peer_dms", focus: ["conversation"] },
  { name: "room_list_files", focus: ["work", "review"] },
  { name: "room_get_file", focus: ["work", "review"] },
  { name: "room_work_claim_provenance", focus: ["work"] },
  { name: "room_work_claim_thread", focus: ["work", "review"] },
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
  { name: "room_activation_pack", core: true, blurb: "Read purpose, permissions and next steps; view:brief is compact. Room-wide work is not assigned to you." },
  { name: "room_read_result", core: true, blurb: "Read exact result evidence, review criteria and action, or inspect a draft.", focus: ["work", "review"] },
  { name: "room_read_work", core: true, blurb: uiText("mcp.core.room_read_work"), focus: ["work", "review"] },
  { name: "room_read_work_discussion", focus: ["work", "review"] },
  { name: "room_post_draft", focus: ["work"] },
  { name: "room_read_inbox", focus: ["conversation"] },
  { name: "room_digest", focus: ["conversation", "common"] },
  { name: "room_project_state", core: true, blurb: "Read work, pending reviews/decisions and deploy evidence. Missing evidence is unknown.", focus: ["conversation", "common"] },
  { name: "room_response_latency", focus: ["conversation"] },
  { name: "room_wait_for_attention", focus: ["conversation", "automation"] },
  { name: "room_link_work_claim_pr", focus: ["work"] },
  { name: "room_begin_work", core: true, blurb: "Begin the selected task at its current revision. Write work needs exact repository/ref/paths/expiry.", focus: ["work"] },
  { name: "room_submit_text_result", core: true, blurb: "Submit your posted result as the completion with exact evidence fields from room_read_result. Retry unchanged on unknown.", focus: ["work"] },
  { name: "room_propose_work", focus: ["work"] },
  { name: "room_propose_plan", focus: ["work"] },
  { name: "room_accept_work", focus: ["work"] },
  { name: "room_start_work", focus: ["work"] },
  { name: "room_block_work", focus: ["work"] },
  { name: "room_resolve_blocker", core: true, blurb: "Resolve your task blocker concretely, then room_begin_work to resume. Read the correction first.", focus: ["work"] },
  { name: "room_record_completion", focus: ["work"] },
  { name: "room_record_verification", core: true, blurb: "Record pass or fail for the exact completion and evidence version from room_read_result. Fail returns work for correction.", focus: ["review"] },
  { name: "room_acquire_claim", focus: ["work"] },
  { name: "room_release_claim", focus: ["work"] },
  { name: "room_renew_claim", focus: ["work"] },
  { name: "room_record_handoff", focus: ["work"] },
  { name: "room_claim", core: true, blurb: uiText("mcp.core.room_claim"), focus: ["work"] },
  { name: "room_handoff", core: true, blurb: "Hand your task back: what is done, next action, why. Does not complete or reassign. haltAll stops your mutations.", focus: ["work"] },
  { name: "room_request_history", focus: ["conversation"] },
  { name: "room_request_reply", core: true, blurb: "Ask one member for a tracked reply (formal request). Plain mentions are untracked.", focus: ["common"] },
  { name: "room_cancel_request", focus: ["common", "conversation"] },
  { name: "room_progress_request", core: true, blurb: "After the exact read, ack a request to you before model work; then accepted, working or needs_input.", focus: ["common", "conversation"] },
  { name: "room_map", focus: ["work"] }
]);
