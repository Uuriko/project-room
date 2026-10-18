import { anonymousPublicWorkMcpTools, publicWorkMcpDefinitions } from './mcp-public-work.mjs';
import { anonymousIdentityMintMcpTools } from './mcp-identity-mint.mjs';
// Binds the one server card to the tool lists the hosted MCP actually serves.
import { MCP_SUPPORTED_VERSIONS } from "../client/mcp-stdio.mjs";
import { ROOM_ORIGIN, ROOM_SOURCE, bindLiveMcpServerCard, deployedInfo } from "./agent-discovery.mjs";
import { createHash } from "node:crypto";
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

// The default tier (PERF-10X lean-as-default decision, 2026-10-16): a
// tools/list with no profile argument serves the lean profile. Core and
// full stay exactly one explicit profile argument away.
export const DEFAULT_MCP_PROFILE = "lean";

// Same list tools/list returns. Default is the lean profile (short blurbs,
// snake_case names). profile "core" is the compact set, "full" is the
// whole catalog. aliases adds the
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

export function listedMcpTools(profile = DEFAULT_MCP_PROFILE, aliases = false, agent = null, focus = undefined) {
  // An identity with no current room membership is served the public-work
  // lobby list on the member tiers (core and the lean default alike);
  // explicit focus=public_work selects the same list for members.
  const outside = focus === "public_work" || ((profile === "core" || profile === "lean") && focus === undefined && agent && !(agent.memberships ?? []).some(member => member.active !== false));
  if (outside) return [...MCP_JOIN_TOOLS, ...publicWorkMcpDefinitions].map(withOpenWorldHint);
  const focusedNames = focus === undefined ? null : new Set([...FOCUS_COMMON_TOOLS, ...MCP_TOOL_FOCUSES[focus]]);
  // profile "lean" (the default): a short front door plus room_search_actions and
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

// The card's enrolled tier is the member catalog: the default (lean) list a
// bearer with a current room membership gets from tools/list with no profile
// argument. It is NOT the non-member list — an identity with no memberships
// is served the public-work lobby list at the door (the "public_work" focus
// branch above), which is a different subject (#3769).
export function liveEnrolledMcpTools() {
  return listedMcpTools(DEFAULT_MCP_PROFILE, false, null);
}

// --- Rev-skip (PERF-10X L5 iii) -------------------------------------------
// The repeat-session mechanism is rev-in-band: the deployed revision plus
// a digest of each catalog tier, exposed in MCP initialize, the server
// card and room_needs_me. An agent that stored both can revalidate with
// tools/list { since_rev, since_digest }; a match answers
// { not_modified: true } instead of the catalog — the in-repo
// since_version precedent (get_room_context) on the catalog itself.
// Booked saving is ZERO until the skip rate is measured in logs: every
// served list and every skip is counted here and each skip writes one
// JSON log line (event "room.mcp_catalog_skip"), so the rate is
// skips / (skips + lists) from the counters or the log lines.
export const CATALOG_SKIP_CONTRACT = "Store deployedRev and the catalog digest for your profile from initialize, the server card, or room_needs_me. On a later session, call tools/list with { since_rev, since_digest }: if both still match, the answer is { not_modified: true } and you keep your stored catalog — skip the fetch. If they differ, the full list rides in that same answer; store its new digest from _meta.catalog.";

const catalogStats = { lists: 0, skips: 0, byProfile: {} };
export function catalogSkipStats() {
  return { lists: catalogStats.lists, skips: catalogStats.skips, byProfile: { ...catalogStats.byProfile } };
}
export function recordCatalogList(profile) {
  catalogStats.lists += 1;
  const entry = catalogStats.byProfile[profile] ??= { lists: 0, skips: 0 };
  entry.lists += 1;
}
export function recordCatalogSkip(profile, rev) {
  catalogStats.skips += 1;
  const entry = catalogStats.byProfile[profile] ??= { lists: 0, skips: 0 };
  entry.skips += 1;
  console.info(JSON.stringify({ event: "room.mcp_catalog_skip", profile, deployedRev: rev, lists: catalogStats.lists, skips: catalogStats.skips }));
}

let catalogDigestsCache = null;
// Digests are over the unfiltered tiers as served to a member with full
// standing: name, description, inputSchema and annotations per tool, in
// list order. The catalog is static per build, so this is computed once.
export function catalogDigests() {
  if (catalogDigestsCache) return catalogDigestsCache;
  const digestOf = tools => createHash("sha256").update(JSON.stringify(tools.map(tool => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations ?? null
  })))).digest("hex");
  const tiers = {
    lean: listedMcpTools("lean", false, null),
    core: listedMcpTools("core", false, null),
    full: listedMcpTools("full", false, null),
    public: livePublicMcpTools()
  };
  catalogDigestsCache = Object.freeze(Object.fromEntries(Object.entries(tiers).map(([profile, tools]) => [profile, Object.freeze({
    digest: digestOf(tools), tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools))
  })])));
  return catalogDigestsCache;
}

export function catalogDigestFor(profile) {
  return catalogDigests()[profile]?.digest ?? null;
}

// The compact rev-skip block carried by initialize, the server card and
// room_needs_me: enough for an agent to store and compare, nothing more.
// The server card is a cacheable public document and must stay
// byte-stable per build, so live skip counters ride only on the dynamic
// answers (initialize, needs-me, a not_modified answer) — pass
// { stats: true } there.
export function catalogRevSummary({ stats = false } = {}) {
  const deployed = deployedInfo();
  const tiers = catalogDigests();
  return {
    deployedRev: deployed.revision,
    buildId: deployed.buildId,
    defaultProfile: DEFAULT_MCP_PROFILE,
    catalogDigest: tiers[DEFAULT_MCP_PROFILE].digest,
    tiers,
    skipContract: CATALOG_SKIP_CONTRACT,
    ...(stats ? { skipStats: catalogSkipStats() } : {})
  };
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
    repositoryUrl: ROOM_SOURCE,
    catalog: catalogRevSummary()
  });
}

bindLiveMcpServerCard(liveMcpServerCardJson);
