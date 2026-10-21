import { anonymousPublicWorkMcpTools, publicWorkMcpDefinitions } from './mcp-public-work.mjs';
import { anonymousIdentityMintMcpTools } from './mcp-identity-mint.mjs';
// Binds the one server card to the tool lists the hosted MCP actually serves.
import { MCP_SUPPORTED_VERSIONS } from "../client/mcp-stdio.mjs";
import { ROOM_ORIGIN, ROOM_SOURCE, bindLiveMcpServerCard } from "./agent-discovery.mjs";
import { ROOM_MCP_PUBLIC_URL, ROOM_MCP_SERVER_VERSION, CORE_MCP_TOOLS, CORE_MCP_BLURBS, mcpToolAlias } from "../src/room-mcp-join.js";
import { MCP_TOOL_META } from "../src/mcp-tool-registry.js";
import { renderMcpServerCardJson } from "../src/mcp-server-card.mjs";
import { MCP_JOIN_TOOLS } from "./mcp-http.mjs";
import { hostedMcpToolDefs } from "./mcp-hosted-tools.mjs";
import { capabilityVisibleTo } from "./capability-visibility.mjs";
import { withOpenWorldHint } from "./content-trust.mjs";
import { LEAN_MCP_TOOLS, actionMetaToolDefs } from "./mcp-action-search.mjs";
import { withMcpToolContract } from "./mcp-tool-contracts.mjs";

export function livePublicMcpTools() {
  return [...MCP_JOIN_TOOLS, ...anonymousPublicWorkMcpTools, ...anonymousIdentityMintMcpTools].map(withOpenWorldHint);
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
// Focus membership is a registry tag (src/mcp-tool-registry.js); the lists
// below are derived views of it. Listing order always comes from the defs,
// never from these tags — membership is consumed as a set.
const focusMembers = tag => MCP_TOOL_META.filter(entry => entry.focus?.includes(tag)).map(entry => entry.name);
const FOCUS_COMMON_TOOLS = focusMembers("common");

// Actor-selected discovery views, not permission or execution profiles. Include
// advanced tools from the full catalog without changing direct-call availability.
export const MCP_TOOL_FOCUSES = Object.freeze({
  public_work: [],
  conversation: focusMembers("conversation"),
  work: focusMembers("work"),
  review: focusMembers("review"),
  automation: focusMembers("automation")
});

// Default tools/list profile. "core" stays selectable for one release.
export const DEFAULT_MCP_PROFILE = "lean";

export function listedMcpTools(profile = DEFAULT_MCP_PROFILE, aliases = false, agent = null, focus = undefined) {
  const outside = focus === "public_work" || ((profile === "core" || profile === "lean") && focus === undefined && agent && !(agent.memberships ?? []).some(member => member.active !== false));
  if (outside) return [...MCP_JOIN_TOOLS, ...publicWorkMcpDefinitions].map(withOpenWorldHint);
  const focusedNames = focus === undefined ? null : new Set([...FOCUS_COMMON_TOOLS, ...MCP_TOOL_FOCUSES[focus]]);
  // profile "lean" (opt-in): a short front door plus room_search_actions and
  // room_run_action for the long tail. The meta tools are listed only here;
  // they stay callable on every profile.
  const leanDefs = [...hostedMcpToolDefs, ...actionMetaToolDefs];
  const source = focusedNames
    ? hostedMcpToolDefs.filter(entry => focusedNames.has(entry.name))
    : profile === "lean"
    ? LEAN_MCP_TOOLS.map(name => leanDefs.find(entry => entry.name === name))
    : profile === "full"
    ? hostedMcpToolDefs
    : CORE_MCP_TOOLS.map(name => hostedMcpToolDefs.find(entry => entry.name === name));
  const tools = source.map(entry => {
    const base = (profile === "core" || profile === "lean") && CORE_MCP_BLURBS[entry.name] ? CORE_MCP_BLURBS[entry.name] : entry.description;
    // Core and lean stay under their byte budget (tests/mcp-core-profile.test.js);
    // the full profile carries the access/cost/REST line (AUX-08).
    const description = profile === "full" ? withMcpToolContract(entry.name, base) : base;
    const alias = mcpToolAlias(entry.name);
    return {
      ...entry,
      description,
      ...(aliases && alias ? { aliases: [alias] } : {})
    };
  });
  const joinTools = profile === "full" ? MCP_JOIN_TOOLS.map(entry => ({ ...entry, description: withMcpToolContract(entry.name, entry.description) })) : MCP_JOIN_TOOLS;
  const listed = [...tools, ...joinTools];
  return [...(agent ? listed.filter(tool => capabilityVisibleTo(agent, tool)) : listed), ...(profile === "full" ? publicWorkMcpDefinitions : [])].map(withOpenWorldHint);
}

// The card's enrolled tier is the member catalog: the default (core) list a
// bearer with a current room membership gets from tools/list with no profile
// argument. It is NOT the non-member list — an identity with no memberships
// is served the public-work lobby list at the door (the "public_work" focus
// branch above), which is a different subject (#3769).
export function liveEnrolledMcpTools() {
  return listedMcpTools(DEFAULT_MCP_PROFILE, false, null);
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
