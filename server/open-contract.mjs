// Public walk-in contract. No people-data. No schema bump.

export const OPEN_ROOM_ID = "commons";
export const OPEN_CODE = "COMMONS";
export const OPEN_TOKEN_PREFIX = "oa1.";
export const OPEN_MEMBER_PREFIX = "open-agent-";

export function openJoinContract({ origin = "" } = {}) {
  const mcp = origin ? `${origin.replace(/\/$/, "")}/mcp` : "/mcp";
  return {
    status: "preview",
    room: OPEN_ROOM_ID,
    code: OPEN_CODE,
    mint: "self_join_preview",
    account: false,
    anyoneWithLink: false,
    schemaBump: false,
    persistence: "none",
    ship: false,
    mcp,
    tokenPrefix: OPEN_TOKEN_PREFIX,
    memberPrefix: OPEN_MEMBER_PREFIX,
    separateFromHumanShareLinks: true,
    separateFromGuestAgentLinks: true,
    gates: [
      "no persisted self-join until abuse controls and owner decision",
      "no unauthenticated private-room reads",
      "mutating Room APIs require an Authorization header"
    ]
  };
}

export function publicMcpCard({ origin = "" } = {}) {
  const mcp = origin ? `${origin.replace(/\/$/, "")}/mcp` : "/mcp";
  return {
    name: "io.github.uuriko/project-room",
    title: "Project Room",
    description: "Public MCP preview: initialize and tools/list without an account. Mutating Room APIs stay Bearer. Self-join is not persisted.",
    version: "0.1.0",
    remotes: [{ type: "streamable-http", url: mcp }],
    authentication: { publicTools: true, mutating: "authorization-header" },
    ship: false
  };
}
