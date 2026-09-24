// Hosted MCP join surface (Steal A). Pasteable URL + host-exact snippets.
// No keys. Room tools stay on local stdio + enrolled credentials.

export const ROOM_MCP_PUBLIC_URL = "https://www.getdasha.com/room/mcp";
export const ROOM_MCP_SERVER_NAME = "project-room";

// Authenticated hosted MCP profile (Authorization: Bearer pri_…).
// Unauthenticated tools/list stays the four join tools. Names are the
// contract shared by the join document, OpenAPI, and the Room Worker handler.
export const HOSTED_ROOM_MCP_TOOLS = Object.freeze([
  "room_check_access",
  "room_activation_pack",
  "get_room_context",
  "room_list_events",
  "room_post_message",
  "room_list_work",
  "bond.propose"
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
    "With Authorization: Bearer <saved-identity-secret> on POST, the same URL adds room tools:",
    HOSTED_ROOM_MCP_TOOLS.join(", ") + ".",
    "room_post_message submits { id, type: \"message.posted\", data: { messageId, body } } through the room command path.",
    "bond.propose submits { id, type: \"bond.propose\", data: { to } }.",
    "Receipts and idempotency stay on that command path. No OAuth. Do not put the secret in tool arguments or chat.",
    "Local stdio remains the full tool set. Shared #join/ links enroll an identity; they are not this bearer credential.",
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
    roomTools: "bearer-identity-secret-or-local-stdio",
    authenticatedTools: HOSTED_ROOM_MCP_TOOLS,
    authorization: "Omit Authorization for the four public join tools. POST with Authorization: Bearer <saved-identity-secret> adds the authenticated room tools. The secret is an identity secret, not a shareable login link.",
    snippets: {
      claude: snippets.claude,
      cursor: snippets.cursor,
      codex: snippets.codex
    }
  };
}
