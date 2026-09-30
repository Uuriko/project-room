// One-line MCP installer route helpers for Project Room.
//
// Portions adapted from Agent Room's api/install.ts
// (https://github.com/agent-room-alkl/agent-room)
// MIT License, Copyright (c) 2026 Agent Room contributors.
//
// Generates the POSIX-sh installer served (once wired) at GET /room/install:
//   curl -fsSL https://www.getdasha.com/room/install | sh
//
// The generated script is a thin bootstrapper: it checks for Node 18+,
// downloads scripts/room-mcp-init.mjs from the same host, and runs it with
// the user's arguments. All client detection and config writing lives in the
// init script, which is the part tests exercise directly.
//
// HTTP wiring is intentionally deferred: server/http.mjs is held by another
// lane, so this module exposes pure route helpers the route can mount later:
//   GET  /room/install    -> mcpInstallScriptResponse(host).body as text/x-shellscript
//   GET  /room/mcp-init.mjs -> serve scripts/room-mcp-init.mjs as text/javascript
//   HEAD /room/install    -> same headers, empty body
//   others               -> 405

export const MCP_INSTALL_PATH = "/room/install";
export const MCP_INIT_PATH = "/room/mcp-init.mjs";

// Source of truth for these lives in src/room-mcp-join.js
// (ROOM_MCP_SERVER_NAME / ROOM_MCP_PUBLIC_URL). Duplicated so the generated
// script needs no build step.
const SERVER_NAME = "project-room";
const DEFAULT_HOST = "https://www.getdasha.com";
const DEFAULT_MCP_URL = "https://www.getdasha.com/room/mcp";

function shQuote(s) {
  if (!/^[\w.:/=-]+$/.test(s)) throw new Error("unsafe value for shell script");
  return s;
}

function manualFallback(mcpUrl) {
  return [
    `No usable Node.js found (need 18+). Install Node, then re-run, or wire the hosted MCP by hand:`,
    ``,
    `Claude Code:`,
    `  claude mcp add --transport http --scope user ${SERVER_NAME} ${mcpUrl}`,
    ``,
    `Cursor (~/.cursor/mcp.json):`,
    `  { "mcpServers": { "${SERVER_NAME}": { "url": "${mcpUrl}" } } }`,
    ``,
    `Codex:`,
    `  codex mcp add ${SERVER_NAME} --url ${mcpUrl}`,
  ].join("\n");
}

// Build the installer shell script. host is the public origin the script was
// served from (e.g. https://www.getdasha.com); initPath is where the init
// script is served on that host.
export function mcpInstallScript({ host = DEFAULT_HOST, initPath = MCP_INIT_PATH, mcpUrl = DEFAULT_MCP_URL } = {}) {
  const base = shQuote(String(host).replace(/\/+$/, ""));
  const initUrl = `${base}${initPath.startsWith("/") ? initPath : `/${initPath}`}`;
  const url = shQuote(mcpUrl);
  const fallback = manualFallback(mcpUrl)
    .split("\n")
    .map((l) => `  echo '${l.replace(/'/g, "'\\''")}' >&2`)
    .join("\n");
  return `#!/bin/sh
# Project Room MCP installer — served from ${base}${MCP_INSTALL_PATH}.
# Portions adapted from Agent Room (https://github.com/agent-room-alkl/agent-room),
# MIT License, Copyright (c) 2026 Agent Room contributors.
#
# Usage:
#   curl -fsSL ${base}${MCP_INSTALL_PATH} | sh
#   curl -fsSL ${base}${MCP_INSTALL_PATH} | sh -s -- cursor codex
#   curl -fsSL ${base}${MCP_INSTALL_PATH} | sh -s -- --dry-run
#
# Forwards all arguments to the init script. When stdin is a pipe (the
# curl | sh case) and no arguments were given, detected clients install
# non-interactively; pass client names or --dry-run to stay in control.
set -eu

MCP_URL='${url}'
INIT_URL='${initUrl}'

# Node 18+ runs the init script. Without it, print the manual fallback and
# stop — a half-installed client is worse than a clear message.
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found (need 18+ to run the Project Room MCP installer)." >&2
${fallback}
  exit 1
fi
NODE_MAJOR="\$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "\$NODE_MAJOR" -lt 18 ]; then
  echo "error: node \$NODE_MAJOR found, need 18+." >&2
${fallback}
  exit 1
fi

TMP_INIT="\$(mktemp -t room-mcp-init.XXXXXX.mjs)"
cleanup() { rm -f "\$TMP_INIT"; }
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --proto '=https' --tlsv1.2 "\$INIT_URL" -o "\$TMP_INIT"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "\$TMP_INIT" "\$INIT_URL"
else
  echo "error: need curl or wget to download the installer." >&2
  exit 1
fi

# Piped stdin is the script itself, not a terminal: the init script cannot
# prompt, so default to non-interactive install of detected clients.
if [ ! -t 0 ] && [ "$#" -eq 0 ]; then
  set -- --yes
fi

exec node "$TMP_INIT" "$@"
`;
}

// Route helper for the deferred GET /room/install wiring. Returns a plain
// { status, headers, body } the HTTP layer can send verbatim.
export function mcpInstallScriptResponse({ host, method = "GET" } = {}) {
  const m = String(method).toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    return {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" },
      body: "Method not allowed. Use: curl -fsSL <host>/room/install | sh\n",
    };
  }
  const body = mcpInstallScript({ host });
  return {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
    body: m === "HEAD" ? "" : body,
  };
}
