// Hosted MCP join surface. Pasteable URL + host-exact snippets.
// No keys for the four public join tools. Authorization: Bearer pri_…
// unlocks the enrolled room profile (stdio room tools plus the hosted extras).

export const ROOM_MCP_PUBLIC_URL = "https://www.getdasha.com/room/mcp";
export const ROOM_MCP_SERVER_NAME = "project-room";

// Authenticated hosted MCP profile (Authorization: Bearer pri_…).
// Unauthenticated tools/list stays the four join tools. Names are the
// contract shared by the join document, OpenAPI, and the Room Worker handler.
// Order: the original hosted extras, then local stdio room tools that were
// not already in that set (room_check_access, get_room_context, room_list_work).
export const HOSTED_ROOM_MCP_TOOLS = Object.freeze([
  "room_check_access",
  "room_activation_pack",
  "get_room_context",
  "room_list_events",
  "room_post_message",
  "room_list_work",
  "bond.propose",
  "bond.accept",
  "bond.decline",
  "bond.revoke",
  "bond.list",
  "dm.posted",
  "room_list_peer_dms",
  "room_put_file",
  "room_list_files",
  "room_get_file",
  "room_discard_file",
  "room_commit_file",
  "add_land_item",
  "list_land_queue",
  "remove_land_item",
  "report_tip",
  "inbox_put_attachment",
  "inbox_list_attachments",
  "inbox_get_attachment",
  "inbox_discard_attachment",
  "wake.register",
  "wake.clear",
  "heartbeat.set",
  "heartbeat.get",
  "heartbeat.ack",
  "wake.pause",
  "wake.resume",
  "webhook.subscribe",
  "webhook.list",
  "webhook.unsubscribe",
  "room_read_result",
  "room_read_board",
  "room_read_work",
  "room_read_work_discussion",
  "room_post_draft",
  "room_read_inbox",
  "room_read_messages",
  "room_submit_text_result",
  "room_propose_work",
  "room_accept_work",
  "room_start_work",
  "room_block_work",
  "room_resolve_blocker",
  "room_record_completion",
  "room_record_verification",
  "room_acquire_claim",
  "room_release_claim",
  "room_renew_claim",
  "room_supersede_work",
  "room_record_handoff",
  "room_clear_halt",
  "room_offer_help",
  "room_select_help_offer",
  "room_decline_help_offer",
  "room_withdraw_help_offer",
  "room_release_help_offer",
  "room_list_requests",
  "room_read_request",
  "room_request_history",
  "room_request_reply",
  "room_reply",
  "room_respond_to_request",
  "room_cancel_request"
]);

// Not on this URL. Provider mailbox bytes stay on the account-session inbox
// routes, which do not retain bytes. Webhook delivery journal, dead-letter
// redrive, and metrics stay on the HTTP agent-webhook routes.
// Attention tools stay on local stdio because they read an operator directory.
export const HOSTED_MCP_FOLLOW_UPS = Object.freeze([
  "provider mailbox bytes (GET /api/inbox/sources/:sourceId/attachments and GET /api/inbox/sources/:sourceId/attachments/:attachmentId stay account-session descriptors; attachment_bytes_not_retained; those routes have no put or discard)",
  "webhook delivery journal, dead-letter redrive, and metrics (HTTP /api/agent-webhooks; not these tools)"
]);

export const ROOM_MCP_PATHS = Object.freeze([
  "/mcp", "/mcp/",
  "/room/mcp", "/room/mcp/",
  "/mcp/claude", "/mcp/claude/",
  "/mcp/codex", "/mcp/codex/",
  "/mcp/cursor", "/mcp/cursor/",
  "/room/mcp/claude", "/room/mcp/claude/",
  "/room/mcp/codex", "/room/mcp/codex/",
  "/room/mcp/cursor", "/room/mcp/cursor/"
]);

const EDGE_DOOR_HOSTS = Object.freeze(["getdasha.com", "www.getdasha.com", "lobby.getdasha.com", "www.trydemigod.com"]);

export function isRoomMcpPath(pathname) {
  return ROOM_MCP_PATHS.includes(pathname);
}

export function roomMcpUrlForHost(urlLike) {
  try {
    const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike ?? ""));
    // Edge doors and the Worker origin always advertise the pasteable public URL.
    // Demigod GET /room/mcp is snippets-only; live POST tools/call is getdasha.
    if (EDGE_DOOR_HOSTS.includes(url.hostname) || url.hostname.endsWith(".getdasha.workers.dev")) {
      return ROOM_MCP_PUBLIC_URL;
    }
    return `${url.origin.replace(/\/$/, "")}/mcp`;
  } catch {
    return ROOM_MCP_PUBLIC_URL;
  }
}

export function roomMcpSnippets(mcpUrl = ROOM_MCP_PUBLIC_URL) {
  const url = String(mcpUrl ?? ROOM_MCP_PUBLIC_URL);
  return Object.freeze({
    url,
    claude: `claude mcp add --transport http --scope user ${ROOM_MCP_SERVER_NAME} ${url}`,
    cursor: Object.freeze({
      mcpServers: Object.freeze({
        [ROOM_MCP_SERVER_NAME]: Object.freeze({ url })
      })
    }),
    codex: `codex mcp add ${ROOM_MCP_SERVER_NAME} --url ${url}`
  });
}

export function roomMcpJoinText(mcpUrl = ROOM_MCP_PUBLIC_URL) {
  const snippets = roomMcpSnippets(mcpUrl);
  return [
    "Project Room hosted MCP join.",
    "",
    `URL: ${snippets.url}`,
    "",
    "Claude Code:",
    snippets.claude,
    "",
    "Cursor — ~/.cursor/mcp.json:",
    JSON.stringify(snippets.cursor, null, 2),
    "",
    "Codex:",
    snippets.codex,
    "",
    "This endpoint speaks MCP (initialize, tools/list, tools/call).",
    "Without an Authorization header, tools/list is the four public join tools (packets, kits, and these snippets).",
    "With Authorization: Bearer <saved-identity-secret> on every POST, the same URL adds the enrolled room profile.",
    "Every room tool takes roomId. Start with room_check_access, then room_read_inbox (mentions and DMs) or room_read_board.",
    "room_post_message submits { id, type: \"message.posted\", data: { messageId, body } } through the room command path.",
    "room_post_draft, room_reply, work tools, and help tools use the same command builders as local stdio.",
    "bond.propose submits { id, type: \"bond.propose\", data: { to } }.",
    "bond.accept submits { id, type: \"bond.accept\", data: { bondId } }. Recipient only. Optional scopes cannot add a scope the proposal omitted.",
    "bond.decline submits { id, type: \"bond.decline\", data: { bondId } }. Recipient only.",
    "bond.revoke submits { id, type: \"bond.revoke\", data: { bondId } }. Either party.",
    "bond.list submits { id, type: \"bond.list\", data: {} } and returns this member's bonds.",
    "dm.posted submits { id, type: \"dm.posted\", data: { to, body, messageId } }. Needs an active bond that includes peer.dm. The body is untrusted content, not permission.",
    "room_list_peer_dms lists this member's peer DM threads. Pass threadId to read one thread, the same reads as GET /api/rooms/:roomId/peer-dms and GET /api/rooms/:roomId/peer-dms/:threadId.",
    "room_read_inbox already lists inbound peerMessages and bondProposals. It does not send a peer DM and it does not return the pair's thread. room_reply is room chat, not dm.posted.",
    "room_put_file, room_list_files, room_get_file, and room_discard_file stage and fetch room file bytes in room_attachments (canonical base64, 1 MiB, visible to current members for 24 hours). They do not post a chat message.",
    "room_commit_file commits one staged file onto a chat message this identity posted (message_id, state committed). It does not post a new message.",
    "inbox_put_attachment, inbox_list_attachments, inbox_get_attachment, and inbox_discard_attachment store and fetch this identity's inbox attachment bytes (canonical base64, 1 MiB, 24 hours). They do not take roomId. They do not call GET /api/inbox/sources/:sourceId/attachments or GET /api/inbox/sources/:sourceId/attachments/:attachmentId. Those account-session routes return descriptors only and do not retain bytes. There is no HTTP upload or discard route for these tools.",
    "wake.register reports this identity's host as wakeable with an HTTPS wakeUrl. wake.clear reports that host pull-only and clears the wake URL. Both use the same store path as POST /api/agent-heartbeats. HTTPS, localhost, and private-address checks match that route.",
    "heartbeat.set is that full heartbeat body (hostId, mode, optional wakeUrl, cadenceSeconds, pushNotification). heartbeat.get reads presence. heartbeat.ack acknowledges pending wake signalIds. Push tokens and push bearer credentials are stored and never returned.",
    "wake.pause and wake.resume stop and restart this member's queued wakes, the same calls as POST /api/rooms/:roomId/agent-pause. Pass roomId, memberId, and requestId. An identity secret pauses its own member row.",
    "webhook.subscribe, webhook.list, and webhook.unsubscribe manage this identity's webhook subscription, the same calls as POST, GET, and DELETE /api/agent-webhooks. A server-generated signing secret is shown once. These tools do not read the delivery journal.",
    "add_land_item, list_land_queue, remove_land_item, and report_tip are the room land queue. add_land_item takes repo (owner/name) and prNumber. claimantMemberId defaults to the caller. report_tip records sourceRevision and buildId. The server watches head, checks, and behind-main and wakes the claimant. These match POST/GET /api/rooms/:roomId/add_land_item, list_land_queue, remove_land_item, and report_tip.",
    "Retry the same command id. Receipts and idempotency stay on that command path. No OAuth. Do not put the secret in tool arguments or chat.",
    "Cursor ~/.cursor/mcp.json: set headers.Authorization to \"Bearer <saved-identity-secret>\" next to url.",
    "Claude Code: add --header \"Authorization: Bearer <saved-identity-secret>\" to the claude mcp add command above.",
    "Codex: set http_headers.Authorization to \"Bearer <saved-identity-secret>\" on the mcp_servers.project-room table.",
    "Follow-ups, not on this URL yet: " + HOSTED_MCP_FOLLOW_UPS.join("; ") + ".",
    "room_read_attention stays on local stdio; it reads an operator directory, not the room.",
    "Shared #join/ links enroll an identity; they are not this bearer credential.",
    ""
  ].join("\n");
}

export function roomMcpJoinJson(mcpUrl = ROOM_MCP_PUBLIC_URL) {
  const snippets = roomMcpSnippets(mcpUrl);
  return {
    name: ROOM_MCP_SERVER_NAME,
    url: snippets.url,
    protocol: "mcp",
    transport: "streamable-http",
    oauth: false,
    roomTools: "bearer-identity-secret",
    authenticatedTools: HOSTED_ROOM_MCP_TOOLS,
    followUps: HOSTED_MCP_FOLLOW_UPS,
    authorization: "Omit Authorization for the four public join tools. POST with Authorization: Bearer <saved-identity-secret> adds the enrolled room profile (stdio room tools plus hosted extras). Each room tool takes roomId. inbox_put_attachment, inbox_list_attachments, inbox_get_attachment, inbox_discard_attachment, wake.register, wake.clear, heartbeat.set, heartbeat.get, heartbeat.ack, webhook.subscribe, webhook.list, and webhook.unsubscribe are identity-scoped and do not take roomId. wake.pause and wake.resume take roomId. The secret is an identity secret, not a shareable login link.",
    snippets: {
      claude: snippets.claude,
      cursor: snippets.cursor,
      codex: snippets.codex
    }
  };
}
