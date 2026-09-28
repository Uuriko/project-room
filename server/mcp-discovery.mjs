// Binds the one server card to the tool lists the hosted MCP actually serves.
import { MCP_SUPPORTED_VERSIONS } from "../client/mcp-stdio.mjs";
import { ROOM_ORIGIN, ROOM_SOURCE, bindLiveMcpServerCard } from "../deploy/agent-discovery.mjs";
import { ROOM_MCP_PUBLIC_URL, ROOM_MCP_SERVER_VERSION, CORE_MCP_TOOLS, CORE_MCP_BLURBS, mcpToolAlias } from "../src/room-mcp-join.js";
import { renderMcpServerCardJson } from "../src/mcp-server-card.mjs";
import { MCP_JOIN_TOOLS } from "./mcp-http.mjs";
import { hostedMcpToolDefs } from "./mcp-hosted-tools.mjs";
import { capabilityVisibleTo } from "./capability-visibility.mjs";

export function livePublicMcpTools() {
  return MCP_JOIN_TOOLS;
}

// Same list tools/list returns. Default is the core profile (short blurbs,
// snake_case names). profile "full" is the whole catalog. aliases adds the
// hidden dotted names. The server card uses the default so it matches a
// bearer tools/list with no profile argument.
// The optional agent descriptor (see server/capability-visibility.mjs)
// filters BEFORE listing: withheld, never refused. A capability the
// agent's grants/tiers do not admit is ABSENT from the returned catalog —
// never present-but-denying. Omit it for the public/unfiltered lists
// (server card, join surface), which stay full by design.
export function listedMcpTools(profile = "core", aliases = false, agent = null) {
  const source = profile === "full"
    ? hostedMcpToolDefs
    : CORE_MCP_TOOLS.map(name => hostedMcpToolDefs.find(entry => entry.name === name));
  const tools = source.map(entry => {
    const description = profile === "core" && CORE_MCP_BLURBS[entry.name] ? CORE_MCP_BLURBS[entry.name] : entry.description;
    const alias = mcpToolAlias(entry.name);
    return {
      ...entry,
      description,
      ...(aliases && alias ? { aliases: [alias] } : {})
    };
  });
  const listed = [...tools, ...MCP_JOIN_TOOLS];
  return agent ? listed.filter(tool => capabilityVisibleTo(agent, tool)) : listed;
}

export function liveEnrolledMcpTools() {
  return listedMcpTools("core", false);
}

export function liveMcpServerCardJson() {
  return renderMcpServerCardJson({
    publicTools: livePublicMcpTools(),
    enrolledTools: liveEnrolledMcpTools(),
    url: ROOM_MCP_PUBLIC_URL,
    mint: `${ROOM_ORIGIN}/api/agent-identities`,
    version: ROOM_MCP_SERVER_VERSION,
    protocolVersions: MCP_SUPPORTED_VERSIONS,
    websiteUrl: ROOM_ORIGIN,
    repositoryUrl: ROOM_SOURCE
  });
}

bindLiveMcpServerCard(liveMcpServerCardJson);
