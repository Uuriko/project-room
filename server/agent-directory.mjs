// HTTP-ready agent directory (lane D).
//
// src/agent-card-registry.mjs is an in-memory card registry for A2A
// negotiation. This module is the public-facing directory surface a
// third-party agent reads over HTTP: publish/withdraw agent card documents,
// list and search with a visibility policy, and build the frozen directory
// document served at the directory endpoint (see agent-plugin-manifest.mjs
// for the canonical URL). Visibility "public" cards appear in the public
// document; "room" cards are visible only to room members (omitted from
// the public document); "private" cards are listed to no one but their
// owner agent.
//
// Pure module: all state is caller-owned (a Map), no network I/O.
// Frozen outputs; malformed inputs throw DirectoryError (coded errors).
class DirectoryError extends Error {
  constructor(code, message) { super(message); this.name = "DirectoryError"; this.code = code; }
}
const fail = (code, message) => { throw new DirectoryError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_directory", message); };

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VISIBILITIES = ["public", "room", "private"];

const validateCard = card => {
  check(card !== null && typeof card === "object", "card must be an object");
  check(typeof card.name === "string" && card.name.length > 0 && card.name.length <= 120,
    "card.name must be 1-120 chars");
  check(typeof card.description === "string" && card.description.length > 0 && card.description.length <= 2000,
    "card.description must be 1-2000 chars");
  check(card.url === undefined || (typeof card.url === "string" && /^https:\/\/\S+$/.test(card.url)),
    "card.url must be an https URL if given");
  check(Array.isArray(card.capabilities) && card.capabilities.length > 0 &&
    card.capabilities.every(c => typeof c === "string" && c.length > 0),
    "card.capabilities must be a non-empty string array");
  check(card.skills === undefined ||
    (Array.isArray(card.skills) && card.skills.every(s => typeof s === "string" && s.length > 0)),
    "card.skills must be a string array if given");
  check(typeof card.version === "string" && VERSION_PATTERN.test(card.version),
    "card.version must be semver x.y.z[-suffix]");
};

const freezeDeep = node => {
  if (Array.isArray(node)) { node.forEach(freezeDeep); return Object.freeze(node); }
  if (node !== null && typeof node === "object") {
    for (const child of Object.values(node)) freezeDeep(child);
    return Object.freeze(node);
  }
  return node;
};

// Create an agent directory. store is a caller-owned Map (agentId -> entry).
export function createAgentDirectory({ store, clock } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  check(clock === undefined || typeof clock === "function", "clock must be a function if given");
  const entries = store ?? new Map();
  const now = clock ?? Date.now;

  const cardDoc = entry => Object.freeze({
    agentId: entry.agentId,
    name: entry.card.name,
    description: entry.card.description,
    url: entry.card.url ?? null,
    capabilities: Object.freeze([...entry.card.capabilities]),
    skills: Object.freeze([...(entry.card.skills ?? [])]),
    version: entry.card.version,
    visibility: entry.visibility,
    publishedAt: entry.publishedAt,
    updatedAt: entry.updatedAt,
  });

  // Publish (or republish) a card document for an agent.
  const publish = ({ agentId, card, visibility = "public" }) => {
    check(typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId),
      "agentId must match ^[a-z][a-z0-9-]*$");
    check(VISIBILITIES.includes(visibility), `visibility must be one of ${VISIBILITIES.join(", ")}`);
    validateCard(card);
    const existing = entries.get(agentId);
    const entry = {
      agentId,
      card: { ...card },
      visibility,
      publishedAt: existing?.publishedAt ?? now(),
      updatedAt: now(),
      withdrawn: false,
    };
    entries.set(agentId, entry);
    return cardDoc(entry);
  };

  const get = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    const entry = entries.get(agentId);
    if (!entry || entry.withdrawn) fail("directory_not_found", `no listed card for "${agentId}"`);
    return cardDoc(entry);
  };

  // List card docs. By default only public, non-withdrawn cards (the public
  // document). Pass includeNonPublic:true only for trusted renderers.
  const list = ({ query = "", capability = null, includeNonPublic = false } = {}) => {
    check(typeof query === "string", "query must be a string");
    check(capability === null || typeof capability === "string", "capability must be a string if given");
    const q = query.trim().toLowerCase();
    const docs = [...entries.values()]
      .filter(e => !e.withdrawn)
      .filter(e => includeNonPublic || e.visibility === "public")
      .filter(e => !q || `${e.card.name} ${e.card.description}`.toLowerCase().includes(q))
      .filter(e => capability === null || e.card.capabilities.includes(capability))
      .map(cardDoc);
    return Object.freeze(docs);
  };

  const withdraw = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    const entry = entries.get(agentId);
    check(entry && !entry.withdrawn, `no listed card for "${agentId}"`);
    entry.withdrawn = true;
    entry.updatedAt = now();
    return Object.freeze({ agentId, withdrawn: true });
  };

  // Build the frozen public directory document served over HTTP.
  const buildDocument = ({ serviceOrigin }) => {
    check(typeof serviceOrigin === "string" && /^https:\/\/\S+$/.test(serviceOrigin),
      "serviceOrigin must be an https URL");
    const doc = {
      version: "1.0.0",
      origin: serviceOrigin,
      generatedAt: now(),
      agents: list().map(agent => ({
        ...agent,
        cardUrl: `${serviceOrigin}/api/agents/directory/${agent.agentId}`,
      })),
    };
    return freezeDeep(JSON.parse(JSON.stringify(doc)));
  };

  return Object.freeze({ publish, get, list, withdraw, buildDocument });
}
export { DirectoryError };
