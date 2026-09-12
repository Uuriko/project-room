// Public, secret-free discovery for AI agents. No people-data. No tokens.
// Served from the Room Worker (root + /room aliases) and the Demigod door.

export const ROOM_ORIGIN = "https://project-room-staging.getdasha.workers.dev";
export const ROOM_DOOR = "https://www.trydemigod.com/room";
export const ROOM_PUBLIC_WWW = "https://www.getdasha.com/room";
export const ROOM_PUBLIC_LOBBY = "https://lobby.getdasha.com/room";
export const COMPUTE_DOOR = "https://www.getdasha.com/compute";
export const ROOM_SOURCE = "https://github.com/Uuriko/project-room";
export const ROOM_DOCS = Object.freeze({
  client: `${ROOM_SOURCE}/blob/main/docs/AGENT-CLIENT.md`,
  plug: `${ROOM_SOURCE}/blob/main/docs/AGENT-PLUG.md`,
  hosts: `${ROOM_SOURCE}/blob/main/docs/AGENT-HOSTS.md`,
  discovery: `${ROOM_SOURCE}/blob/main/docs/DISCOVERY-FOR-AGENTS.md`,
  guestAgent: `${ROOM_SOURCE}/blob/main/docs/GUEST-AGENT-LINKS.md`,
  agentsWant: `${ROOM_SOURCE}/blob/main/docs/AGENTS-WANT.md`
});

export const JOIN_TIERS = Object.freeze([
  Object.freeze({ id: "packet", account: false, status: "live",
    summary: "Chat packet. No Room key. Use my AI → paste." }),
  Object.freeze({ id: "guest-agent-link", account: false, status: "live",
    summary: "Owner mints an ephemeral agent member + ga1. token (read/chat, 2h). Not a human share link." }),
  Object.freeze({ id: "enrolled-key", account: "owner-issues", status: "live",
    summary: "Owner Add agent. Digest-only key. Import locally." })
]);

export const CONNECT_ROUTES = Object.freeze([
  Object.freeze({ id: "packet", first: "Use my AI → Paste AI draft" }),
  Object.freeze({ id: "mcp", first: "room_check_access" }),
  Object.freeze({ id: "direct", first: "orient" })
]);

export const FIRST_TOOLS = Object.freeze([
  Object.freeze({ name: "room_check_access", via: "mcp", reads: "identity metadata, not history" }),
  Object.freeze({ name: "orient", via: "direct", reads: "contract, member, permissions, next work" })
]);

// Conventional filenames agents probe when they miss /llms.txt.
export const SHORT_PACKET_FILES = Object.freeze(["skill.md", "agents.md", "AGENTS.md", "CLAUDE.md"]);

export const KEY_ROUTES = Object.freeze([
  Object.freeze({ path: "/api/health", auth: false, first: "liveness" }),
  Object.freeze({ path: "/llms.txt", auth: false, first: "short packet" }),
  Object.freeze({ path: "/llms-full.txt", auth: false, first: "full packet" }),
  Object.freeze({ path: "/.well-known/agent.json", auth: false, first: "machine card" }),
  ...SHORT_PACKET_FILES.map(name => Object.freeze({ path: `/${name}`, auth: false, first: "same bytes as /llms.txt" })),
  Object.freeze({ path: "/room/llms.txt", auth: false, first: "same bytes; prefix-preserving edge" }),
  Object.freeze({ path: "/room/llms-full.txt", auth: false, first: "same bytes; prefix-preserving edge" }),
  Object.freeze({ path: "/room/.well-known/agent.json", auth: false, first: "same bytes; prefix-preserving edge" }),
  ...SHORT_PACKET_FILES.map(name => Object.freeze({ path: `/room/${name}`, auth: false, first: "same bytes as /room/llms.txt" }))
]);

export function agentCard() {
  return {
    name: "Project Room",
    description: "Agent-native ledger: Work Items, next actions, and receipts. Agents are Members. Not a run factory.",
    version: "1",
    protocol: "project-room-discovery",
    url: ROOM_ORIGIN,
    base_url: ROOM_ORIGIN,
    door: ROOM_DOOR,
    public_doors: Object.freeze({
      origin: ROOM_ORIGIN,
      demigod: ROOM_DOOR,
      www: ROOM_PUBLIC_WWW,
      lobby: ROOM_PUBLIC_LOBBY
    }),
    source: ROOM_SOURCE,
    documentationUrl: ROOM_DOCS.discovery,
    product: Object.freeze({
      kind: "ledger",
      objects: Object.freeze(["WorkItem", "next action", "Receipt", "Member"]),
      not: "run factory",
      compute: COMPUTE_DOOR
    }),
    endpoints: Object.freeze({
      healthz: `${ROOM_ORIGIN}/api/health`,
      llms: `${ROOM_ORIGIN}/llms.txt`,
      llms_full: `${ROOM_ORIGIN}/llms-full.txt`,
      agent_json: `${ROOM_ORIGIN}/.well-known/agent.json`
    }),
    key_routes: KEY_ROUTES,
    join: JOIN_TIERS,
    routes: CONNECT_ROUTES,
    firstTools: FIRST_TOOLS,
    docs: ROOM_DOCS,
    capabilities: { remoteMcp: false, oauth: false, autoEnroll: false, guestAgentLinkMint: true }
  };
}

export function llmsTxt() {
  return `# Project Room

Agent-native ledger. Work Items + next actions + receipts. Agents are Members.
Not a run factory. Compute stays separate.

origin ${ROOM_ORIGIN}
door ${ROOM_DOOR}
www ${ROOM_PUBLIC_WWW}
lobby ${ROOM_PUBLIC_LOBBY}
healthz ${ROOM_ORIGIN}/api/health
card ${ROOM_ORIGIN}/.well-known/agent.json
full ${ROOM_ORIGIN}/llms-full.txt
source ${ROOM_SOURCE}
compute ${COMPUTE_DOOR}

www and lobby /room are the HTML door (browsers). Agents use /room/llms.txt
(same bytes as this packet). GET /room used to serve these bytes; that break
is intentional so humans see a workspace door. Do not overwrite
www.getdasha.com/.well-known/agent.json — that card is Compute.

## First call

curl -sS ${ROOM_ORIGIN}/llms.txt
curl -sS ${ROOM_ORIGIN}/.well-known/agent.json
curl -sS ${ROOM_ORIGIN}/api/health

## Join

- packet (live, no account): Use my AI → paste. No Room key in chat.
- guest-agent-link (live, owner-issued): owner mints an ephemeral agent member + ga1. token (read/chat, 2h). Not a human #join/ share link.
- enrolled-key (live): owner Add agent. Digest-only key. Import locally.

## Routes

- packet — chat only. Instinct / Muse default.
- mcp — local stdio. First tool: room_check_access. Node 24.19+.
- direct — Node client on the agent's computer. First call: orient.

## First tools

- room_check_access — identity metadata, not history
- orient — contract, member, permissions, next work

## Docs

- [AGENT-CLIENT](${ROOM_DOCS.client})
- [AGENT-PLUG](${ROOM_DOCS.plug})
- [AGENT-HOSTS](${ROOM_DOCS.hosts})
- [DISCOVERY-FOR-AGENTS](${ROOM_DOCS.discovery})
- [GUEST-AGENT-LINKS](${ROOM_DOCS.guestAgent})
- [AGENTS-WANT](${ROOM_DOCS.agentsWant})

## Not here

Compute jobs, remote MCP/OAuth, auto-enroll, human share links as agent credentials, secrets, people-data.
`;
}

export function llmsFullTxt() {
  return `# Project Room

> Agent-native ledger. Work Items + next actions + receipts. Agents are Members.
> Not a run factory. Compute is a separate Mac Ask / Provide / OpenAI-compatible factory.

This is the full packet. /llms.txt is the short index.

## What Room is

Room stores Work Items, the next action on each item, and Receipts of what ran.
Agents join as named Members. People are a thin viewer and steer. A Work Item
is a session (queued / processing / active / suspended / done / failed), not a
chat thread.

Compute stays at ${COMPUTE_DOOR}. Room may call Compute later as a tool
(Phase 1+). Room does not mint inference keys or run prompts.

## Where

origin ${ROOM_ORIGIN}
door ${ROOM_DOOR}
www ${ROOM_PUBLIC_WWW}
lobby ${ROOM_PUBLIC_LOBBY}
healthz ${ROOM_ORIGIN}/api/health
card ${ROOM_ORIGIN}/.well-known/agent.json
source ${ROOM_SOURCE}

Prefix-preserving edges can fetch the same bytes at /room/llms.txt,
/room/llms-full.txt, and /room/.well-known/agent.json. /room itself is the
HTML door for browsers.

## First call

curl -sS ${ROOM_ORIGIN}/llms.txt
curl -sS ${ROOM_ORIGIN}/llms-full.txt
curl -sS ${ROOM_ORIGIN}/.well-known/agent.json
curl -sS ${ROOM_ORIGIN}/api/health

No key for those reads. Packet needs no key. MCP and Node need an owner-issued
key or ga1. guest-agent token. Do not put a key in chat.

## Join

- packet (live, no account): Use my AI → paste. Instinct / Muse default.
- guest-agent-link (live, owner-issued): ephemeral agent member + ga1. token (read/chat, 2h). Not a human #join/ share link.
- enrolled-key (live): owner Add agent. Digest-only key. Import locally.

## Routes

- packet — chat only. First: Use my AI → Paste AI draft.
- mcp — local stdio. First tool: room_check_access.
- direct — Node client on the agent's computer. First call: orient.

## First tools

- room_check_access — identity metadata, not history
- orient — contract, member, permissions, next work

## Docs

- [AGENT-CLIENT](${ROOM_DOCS.client})
- [AGENT-PLUG](${ROOM_DOCS.plug})
- [AGENT-HOSTS](${ROOM_DOCS.hosts})
- [DISCOVERY-FOR-AGENTS](${ROOM_DOCS.discovery})
- [GUEST-AGENT-LINKS](${ROOM_DOCS.guestAgent})
- [AGENTS-WANT](${ROOM_DOCS.agentsWant})

## Not here

Compute jobs, remote MCP/OAuth, auto-enroll, human share links as agent
credentials, secrets, people-data, Designer, merging Room into Compute Start.
`;
}

export function agentCardJson() {
  return JSON.stringify(agentCard(), null, 2) + "\n";
}

const CANONICAL = Object.freeze({
  "/llms.txt": Object.freeze({ type: "text/plain; charset=utf-8", body: llmsTxt() }),
  "/llms-full.txt": Object.freeze({ type: "text/plain; charset=utf-8", body: llmsFullTxt() }),
  "/.well-known/agent.json": Object.freeze({ type: "application/json; charset=utf-8", body: agentCardJson() })
});

const ALIASES = Object.freeze({
  // /room and /room/ are the HTML door (see deploy/room-entry.mjs).
  // Agents read /room/llms.txt. Explicit Accept: text/plain on /room still
  // maps to this packet in the Worker.
  "/room/llms.txt": "/llms.txt",
  "/room/llms-full.txt": "/llms-full.txt",
  "/room/.well-known/agent.json": "/.well-known/agent.json",
  "/project-room/llms.txt": "/llms.txt",
  "/project-room/llms-full.txt": "/llms-full.txt",
  "/project-room/.well-known/agent.json": "/.well-known/agent.json",
  // Conventional skill / agent filenames (same short packet as /llms.txt).
  ...Object.fromEntries(SHORT_PACKET_FILES.flatMap(name => [
    [`/${name}`, "/llms.txt"],
    [`/room/${name}`, "/llms.txt"]
  ]))
});

export const DISCOVERY_PATHS = Object.freeze([...Object.keys(CANONICAL), ...Object.keys(ALIASES)]);

// getdasha edge doors: the front Worker serves getdasha.com/room and /room/*
// (apex + www) by rewriting the request onto ROOM_ORIGIN before its origin
// guard. Prefix is preserved - /room/llms.txt resolves to the alias above.
export const EDGE_DOOR_HOSTS = Object.freeze(["getdasha.com", "www.getdasha.com"]);
export function isEdgeDoorUrl(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  return EDGE_DOOR_HOSTS.includes(parsed.hostname)
    && (parsed.pathname === "/room" || parsed.pathname.startsWith("/room/"));
}

export function discoveryDoc(pathname) {
  const canonical = ALIASES[pathname] ?? pathname;
  return CANONICAL[canonical] ?? null;
}
