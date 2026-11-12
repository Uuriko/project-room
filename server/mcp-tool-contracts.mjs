import { boardClaimToolsEnabled } from "./board-claim-tools.mjs";
// AUX-08: on the full MCP profile, each front-door tool (the core and lean
// lists) states its access, its cost and its REST twin in the description, so an agent
// that reads only tools/list knows who may call it, what it costs and how to
// do the same thing over plain HTTP. Core and lean keep their short blurbs to
// stay inside the core byte budget. tests/mcp-tool-contracts.test.js lints
// the full list against this table and against CORE_REST_TWINS.
// No store, no secrets, no network.

const COMMANDS = "POST /api/rooms/{roomId}/commands";
const READ = "read only, starts no AI";
const WRITE = "one write, starts no AI";
const POST = "one write; @mentions queue wakes for those members";
const MEMBER = "room member";
const MEMBER_WRITE = "room member; hidden from guest and read-only-tier agents";
const GUEST_OK = "room member; guests allowed; hidden from read-only-tier agents";
const ANY = "any identity secret";
const ANY_OR_ROOM = "any identity secret, or a room token (rak_) on /mcp; the REST twin needs the identity secret";
const STATIC = "any caller, no secret needed";

export const MCP_TOOL_CONTRACTS = Object.freeze({
  room_docs: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/docs; GET /api/rooms/{roomId}/docs/{docId}" },
  room_write_doc: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/docs/{docId}" },
  room_wait_for_attention: {access: `read, ${MEMBER}; same scopes as room_read_inbox`, cost: "read only, at most four bounded inbox probes and one pending wait, starts no AI", rest: "none; use GET /api/rooms/{roomId}/agent-inbox for immediate reads"},
  room_work_claim_thread: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/work-claims/{claimId}/thread" },
  room_needs_me: { access: `read, ${ANY_OR_ROOM}`, cost: READ, rest: "GET /api/needs-me" },
  room_read_messages: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/events" },
  room_mark_caught_up: { access: "write, room member; hidden from guest and read-only-tier catalogs; reader access updates own read-position marker only", cost: "one cursor upsert; posts nothing", rest: "POST /api/rooms/{roomId}/cursor" },
  room_post_message: { access: `write, ${GUEST_OK}`, cost: POST, rest: `${COMMANDS} (message.posted)` },
  room_reply: { access: `write, ${MEMBER_WRITE}`, cost: POST, rest: `${COMMANDS} (message.posted)` },
  room_list_requests: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/reply-requests" },
  room_read_request: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/reply-context" },
  room_respond_to_request: { access: `write, ${MEMBER_WRITE}`, cost: POST, rest: `${COMMANDS} (message.posted)` },
  dm_posted: { access: "write, room member with no bond needed; hidden from guest and read-only-tier agents", cost: WRITE, rest: `${COMMANDS} (dm.posted)` },
  room_check_access: { access: `read, ${ANY_OR_ROOM}`, cost: READ, rest: "GET /api/agent-rooms" },
  room_read_bootstrap: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/bootstrap" },
  room_create: { access: `write, ${ANY}; hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/agent-rooms" },
  room_join: { access: `write, ${ANY} with a share link, invite code, or room pairing; hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/share-links/join-agent or POST /api/agent-invites/redeem or POST /api/pair" },
  room_merge_members: { access: `write, room owner or a member with manage_members and decide; hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/rooms/{roomId}/members/merge" },
  room_put_file: { access: `write, ${MEMBER_WRITE}`, cost: "stages at most 1 MiB; others see nothing until room_commit_file", rest: "POST /api/rooms/{roomId}/files" },
  room_list_files: { access: `read, ${MEMBER}`, cost: "normalized: up to 8 metadata entries for 1–8 selected visible messages per page; legacy list may expire staging; starts no AI", rest: "GET /api/rooms/{roomId}/files?messageId={messageId} (repeat messageId for the same selection; cursor continues it)" },
  room_commit_file: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/files/{id}/commit" },
  add_land_item: { access: `write, ${MEMBER_WRITE}`, cost: "one write; does not merge or deploy", rest: "POST /api/rooms/{roomId}/add_land_item" },
  list_land_queue: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/list_land_queue" },
  remove_land_item: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/remove_land_item" },
  report_tip: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/report_tip" },
  get_room_context: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/context" },
  inbox_put_attachment: { access: "write, any identity secret; stages this identity's bytes only; hidden from guest and read-only-tier agents", cost: "one write; canonical base64, at most 1 MiB decoded, staged 24 hours", rest: "none; no HTTP upload route" },
  inbox_list_attachments: { access: "read, any identity secret; lists this identity's staged attachments only", cost: "metadata read; may purge expired staging, starts no AI", rest: "none; the account-session attachment routes are separate descriptors" },
  inbox_get_attachment: { access: "read, any identity secret; returns this identity's staged bytes only", cost: "downloads one file; may purge expired staging, starts no AI", rest: "none; the account-session attachment routes are separate descriptors" },
  inbox_discard_attachment: { access: "write, any identity secret; discards this identity's attachment only; hidden from guest and read-only-tier agents", cost: WRITE, rest: "none; no HTTP DELETE on the account-session attachment routes" },
  wake_pause: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/agent-pause" },
  wake_resume: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/agent-pause" },
  bond_propose: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: `${COMMANDS} (bond.propose)` },
  room_join_packet: { access: `read, ${STATIC}`, cost: READ, rest: "none, a static enrollment document" },
  room_join_kits: { access: `read, ${STATIC}`, cost: READ, rest: "none, a static kits document" },
  room_join_prompt: { access: `read, ${STATIC}`, cost: READ, rest: "none, a static door prompt document" },
  room_mcp_snippet: { access: `read, ${STATIC}`, cost: READ, rest: "none, static host config snippets" },
  // Public-profile only: served by livePublicMcpTools, never on full, so
  // the full-only ratchet could not see it. The handler is the same
  // anonymous mint as its REST twin (budgets and proof-of-work included).
  room_identity_mint: { access: `write, ${STATIC}`, cost: "one write, starts no AI; returns a one-time identity secret shown once; anonymous budgets apply and repeated mints may require proof-of-work", rest: "POST /api/agent-identities" },
  room_search_actions: { access: `read, ${ANY}; lists only actions this identity may call`, cost: READ, rest: "none; REST discovery is docs/openapi.yaml" },
  room_run_action: { access: "same as the wrapped action", cost: "same as the wrapped action", rest: "the wrapped action's own REST twin" },
  room_list_work: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/work-claims" },
  room_read_work: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/work-claims/{claimId}" },
  room_claim: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: `POST /api/rooms/{roomId}/work-claims/{claimId}/claim; ${COMMANDS} (claim.acquired, claim.renewed, claim.released)` },
  room_handoff: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: `${COMMANDS} (work.handoff_recorded)` },
  // AUX-08b batch 1: bonds, heartbeats and wakes, identity trust reads, squads, webhooks.
  bond_accept: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: `${COMMANDS} (bond.accept)` },
  bond_decline: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: `${COMMANDS} (bond.decline)` },
  bond_revoke: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: `${COMMANDS} (bond.revoke)` },
  bond_list: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/bonds" },
  heartbeat_set: { access: "write, T1 read-only tier or room member; hidden from guest", cost: WRITE, rest: "POST /api/agent-heartbeats" },
  heartbeat_get: { access: `read, ${ANY}`, cost: READ, rest: "GET /api/agent-heartbeats" },
  heartbeat_ack: { access: "write, T1 read-only tier or room member; hidden from guest", cost: WRITE, rest: "POST /api/agent-heartbeats/ack" },
  wake_register: { access: "write, any identity secret; hidden from guest and read-only-tier agents", cost: WRITE, rest: "POST /api/agent-heartbeats (mode wakeable)" },
  wake_clear: { access: "write, any identity secret; hidden from guest and read-only-tier agents", cost: WRITE, rest: "POST /api/agent-heartbeats (mode pull-only)" },
  identity_list_verified: { access: `read, ${MEMBER}`, cost: READ, rest: "none; the per-identity twin is GET /api/agent-identities/{id}/verification" },
  identity_read_verification: { access: `read, ${ANY}`, cost: READ, rest: "GET /api/agent-identities/{id}/verification" },
  squads_list: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/squads" },
  squads_get: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/squads/{squadId}" },
  squads_create: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/squads" },
  squads_update_members: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/squads/{squadId}/members" },
  squads_disband: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/squads/{squadId}/disband" },
  webhook_subscribe: { access: "write, any identity secret; hidden from guest and read-only-tier agents", cost: WRITE, rest: "POST /api/agent-webhooks" },
  webhook_list: { access: `read, ${ANY}`, cost: READ, rest: "GET /api/agent-webhooks" },
  webhook_unsubscribe: { access: "write, any identity secret; hidden from guest and read-only-tier agents", cost: WRITE, rest: "DELETE /api/agent-webhooks/{subscriptionId}" },
  // AUX-08b batch 8: the work lifecycle tools, help offers, reply requests.
  room_accept_work: { access: `write, assigned room member with accept_work; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.accepted)` },
  room_acquire_claim: { access: `write, assigned member with Board write access (eligible human, contribute/review/collaborate agent profile, or room owner); hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (claim.acquired)` },
  room_begin_work: { access: `write, assigned room member with accept_work; write mode also needs write authority; acquiring a claim needs Board write access; hidden from guest and read-only-tier agents`, cost: "runs the next verified Room operations, starts no AI", rest: `${COMMANDS} (work.accepted, claim.acquired, work.started)` },
  room_block_work: { access: `write, room member with assigned accept_work; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.blocked)` },
  room_clear_halt: { access: `write, room member with steer or decide and the exact halt event; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.halt_cleared)` },
  room_close_work_claim: { access: `write, Board writer who is the claim holder or a claim manager (room owner or manage_claims); cancel also the item's creator while it is still unclaimed; hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/rooms/{roomId}/work-claims/{claimId}/close or /cancel" },
  room_decline_help_offer: { access: `write, the active accountable member or active human room owner; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.help_offer_updated)` },
  room_link_work_claim_pr: { access: `write, Board writer holding the active claim; hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/rooms/{roomId}/work-claims/{claimId}/update" },
  room_offer_help: { access: `write, room member with current invitation eligibility and capacity; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.help_offer_opened)` },
  room_propose_work: { access: `write, room member with steer; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.proposed)` },
  room_record_completion: { access: `write, assigned room member with complete_work; write mode also needs current write authority and an active claim; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.completed)` },
  room_record_handoff: { access: `write, assigned member with accept_work and Board write access; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.handoff_recorded)` },
  room_record_verification: { access: `write, room member with designated verify authority; an independent review cannot be by its producer; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (verification.recorded)` },
  room_release_claim: { access: `write, Board writer who holds the claim or has manage_claims; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (claim.released)` },
  room_renew_claim: { access: `write, Board writer holding the active claim; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (claim.renewed)` },
  room_request_history: { access: `read, room member`, cost: READ, rest: "GET /api/rooms/{roomId}/reply-history" },
  room_cancel_request: { access: `write, room member who asked, or the human room owner; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (reply_request.cancelled)` },
  room_progress_request: { access: `write, room member the request is addressed to; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (reply_request.progressed)` },
  room_request_reply: { access: `write, room member; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (message.posted)` },
  room_resolve_blocker: { access: `write, room member with assigned accept_work; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.blocker_resolved)` },
  room_select_help_offer: { access: `write, the accountable member of the task; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.help_offer_updated)` },
  room_start_work: { access: `write, assigned room member with accept_work; write mode also needs write authority and an active claim; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.started)` },
  room_submit_text_result: { access: `write, assigned room member with complete_work; write mode also needs write authority and an active claim; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.completed)` },
  room_supersede_work: { access: `write, room member with steer and Board write access; hidden from guest and read-only-tier agents`, cost: WRITE, rest: `${COMMANDS} (work.superseded)` },
  room_map: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/map/query" }
  // Flag ROOM_BOARD_CLAIM_TOOLS (off by default): contracts exist only when listed.
  ,...(boardClaimToolsEnabled() ? {
    room_work_claim: { access: `write, Board writer (finish: the holder); hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/rooms/{roomId}/work-claims/{claimId}/claim, POST /api/rooms/{roomId}/work-claims/{claimId}/update" } } : {})
});

export function mcpToolContractLine(name) {
  const contract = MCP_TOOL_CONTRACTS[name];
  if (!contract) return null;
  return `Access: ${contract.access}. Cost: ${contract.cost}. REST: ${contract.rest}.`;
}

export function withMcpToolContract(name, description) {
  const line = mcpToolContractLine(name);
  if (!line || typeof description !== "string" || description.includes(line)) return description;
  return `${description.trimEnd()} ${line}`;
}
