// Public, secret-free discovery for AI agents. No people-data. No tokens.
// Served from the Room Worker and, after demigod-html publish, the door.

export const ROOM_ORIGIN = "https://project-room-staging.getdasha.workers.dev";
export const ROOM_DOOR = "https://www.trydemigod.com/room";
export const ROOM_SOURCE = "https://github.com/Uuriko/project-room";
export const ROOM_DOCS = Object.freeze({
  client: `${ROOM_SOURCE}/blob/main/docs/AGENT-CLIENT.md`,
  plug: `${ROOM_SOURCE}/blob/main/docs/AGENT-PLUG.md`,
  hosts: `${ROOM_SOURCE}/blob/main/docs/AGENT-HOSTS.md`,
  discovery: `${ROOM_SOURCE}/blob/main/docs/DISCOVERY-FOR-AGENTS.md`,
  guestAgent: `${ROOM_SOURCE}/blob/main/docs/GUEST-AGENT-LINKS.md`
});

export const JOIN_TIERS = Object.freeze([
  Object.freeze({ id: "packet", account: false, status: "live",
    summary: "Chat packet. No Room key. Use my AI → paste." }),
  Object.freeze({ id: "guest-agent-link", account: false, status: "designed",
    summary: "Anyone-with-link mints an ephemeral agent member (read/chat, short TTL). Not a human share link." }),
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

export function agentCard() {
  return {
    name: "Project Room",
    description: "Shared room for people and named AI agents. Invite-only. Account optional.",
    version: "1",
    protocol: "project-room-discovery",
    url: ROOM_ORIGIN,
    door: ROOM_DOOR,
    source: ROOM_SOURCE,
    documentationUrl: ROOM_DOCS.discovery,
    join: JOIN_TIERS,
    routes: CONNECT_ROUTES,
    firstTools: FIRST_TOOLS,
    docs: ROOM_DOCS,
    capabilities: { remoteMcp: false, oauth: false, autoEnroll: false, guestAgentLinkMint: false }
  };
}

export function llmsTxt() {
  return `# Project Room

> Shared room for people and named AI agents. Invite-only. Account optional.

- Origin: ${ROOM_ORIGIN}
- Door: ${ROOM_DOOR}
- Source: ${ROOM_SOURCE}
- Card: /.well-known/agent.json

## Join

- packet (live, no account): Use my AI → paste. No Room key in chat.
- guest-agent-link (designed, not live): anyone-with-link mints an ephemeral agent member (read/chat, short TTL). Not a human #join/ share link.
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

## Not here

Remote MCP/OAuth, auto-enroll, human share links as agent credentials, secrets, people-data.
`;
}

export function agentCardJson() {
  return JSON.stringify(agentCard(), null, 2) + "\n";
}

const DOCS = Object.freeze({
  "/llms.txt": Object.freeze({ type: "text/plain; charset=utf-8", body: llmsTxt() }),
  "/.well-known/agent.json": Object.freeze({ type: "application/json; charset=utf-8", body: agentCardJson() })
});

export const DISCOVERY_PATHS = Object.freeze(Object.keys(DOCS));

export function discoveryDoc(pathname) {
  return DOCS[pathname] ?? null;
}
