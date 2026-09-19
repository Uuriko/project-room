// Hosted MCP join surface (Steal A). Pasteable URL + host-exact snippets.
// No keys. Room tools stay on local stdio + enrolled credentials.

export const ROOM_MCP_PUBLIC_URL = "https://www.getdasha.com/room/mcp";
export const ROOM_MCP_SERVER_NAME = "project-room";

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
    "This endpoint speaks MCP (initialize, tools/list, tools/call) for public packets, kits, and join snippets.",
    "Room tools (room_check_access, work) still use local stdio + an enrolled key or ga1. guest-agent token.",
    "No OAuth. No keys on this URL. Human #join/ links are not agent auth.",
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
    roomTools: "local-stdio",
    snippets: {
      claude: snippets.claude,
      cursor: snippets.cursor,
      codex: snippets.codex
    }
  };
}
