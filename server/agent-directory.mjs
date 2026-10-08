import {
  isValidPublicKey,
  verifyCardSignature,
  verifyKeyRotation,
} from "./agent-card-signing.mjs";

// HTTP-ready agent directory (lane D).
//
// Cards are SIGNED (RC-2026-09-18-014, research rec A4): publish requires a
// valid Ed25519 signature over the canonical card body, and every card doc
// exposes publicKey + signature so any third party can verify the card
// offline. Key rotation is a chain of custody — a new key must be authorized
// by the old key's rotation signature, unless the caller is the owning
// identity's owner running an explicit recovery (allowRecovery, enforced by
// the store/HTTP layer, never by this pure module on its own authority).
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
const TRUST_STATUSES = ["active", "paused", "revoked"];

const validateCard = card => {
  check(card !== null && typeof card === "object", "card must be an object");
  check(typeof card.name === "string" && card.name.length > 0 && card.name.length <= 120,
    "card.name must be 1-120 chars");
  check(typeof card.description === "string" && card.description.length > 0 && card.description.length <= 2000,
    "card.description must be 1-2000 chars");
  check(card.url === undefined || card.url === null || (typeof card.url === "string" && /^https:\/\/\S+$/.test(card.url)),
    "card.url must be an https URL or null if given");
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

// Validate one trust-evidence record from the trust source. Returns a frozen
// record, or null when the source has nothing for the agent. Trust evidence
// is host-supplied (approver, authority envelope, lifecycle status, last
// seen, verification tier) — it is never self-asserted by the card publisher.
const validateTrust = record => {
  if (record === null || record === undefined) return null;
  check(record !== null && typeof record === "object", "trust() must return an object or null");
  const {
    approvedBy = null,
    approvedAt = null,
    grants = [],
    status = "active",
    lastSeenAt = null,
    // RC-2026-09-18-049: verification tier, host-supplied alongside trust
    // evidence. Explicit "unverified" keeps the default tier visible rather
    // than ambiguous; null means the host supplies no tier.
    verification = null,
  } = record;
  check(approvedBy === null || (typeof approvedBy === "string" && approvedBy.length > 0),
    "trust.approvedBy must be a non-empty string or null");
  check(approvedAt === null || (typeof approvedAt === "number" && approvedAt > 0),
    "trust.approvedAt must be a positive number or null");
  check(Array.isArray(grants) && grants.every(g => typeof g === "string" && g.length > 0),
    "trust.grants must be a string array");
  check(TRUST_STATUSES.includes(status),
    `trust.status must be one of ${TRUST_STATUSES.join(", ")}`);
  check(lastSeenAt === null || (typeof lastSeenAt === "number" && lastSeenAt > 0),
    "trust.lastSeenAt must be a positive number or null");
  check(verification === null || verification === "verified" || verification === "unverified",
    "trust.verification must be verified, unverified, or null");
  const evidence = {
    approvedBy,
    approvedAt,
    grants: Object.freeze([...grants]),
    status,
    lastSeenAt,
  };
  // Additive: the tier rides along only when the trust source supplies one,
  // so existing consumers see no shape change.
  if (verification !== null) evidence.verification = verification;
  return Object.freeze(evidence);
};

// Validate one reach record from the reach source. Returns a frozen
// record, or null when the source has nothing for the agent. Reach is
// host-supplied (wake mode from live host registrations, unacked wake
// count from the live wake queue, bond status from live bond data, host
// from the newest heartbeat) — it is never self-asserted by the card
// publisher and never fabricated: unknown fields stay null.
const WAKE_MODES = ["wakeable", "pull-only", "none"];
const BOND_STATUSES = ["active", "pending", "none"];
const validateReach = record => {
  if (record === null || record === undefined) return null;
  check(record !== null && typeof record === "object" && !Array.isArray(record), "reach() must return an object or null");
  const {
    wakeMode = null,
    lastPollAt = null,
    pendingUnacked = 0,
    bondStatus = null,
    host = null,
  } = record;
  check(wakeMode === null || WAKE_MODES.includes(wakeMode),
    `reach.wakeMode must be one of ${WAKE_MODES.join(", ")} or null`);
  check(lastPollAt === null || (typeof lastPollAt === "number" && lastPollAt > 0),
    "reach.lastPollAt must be a positive number or null");
  check(Number.isInteger(pendingUnacked) && pendingUnacked >= 0,
    "reach.pendingUnacked must be a non-negative integer");
  check(bondStatus === null || BOND_STATUSES.includes(bondStatus),
    `reach.bondStatus must be one of ${BOND_STATUSES.join(", ")} or null`);
  check(host === null || (typeof host === "string" && host.length > 0),
    "reach.host must be a non-empty string or null");
  return Object.freeze({ wakeMode, lastPollAt, pendingUnacked, bondStatus, host });
};

// Validate one owns list from the owns source. Returns a frozen string
// array, or null when the source has nothing for the agent. Owns is
// host-supplied (areas/lanes derived from the agent's live claim data) —
// it is never self-asserted by the card publisher.
const validateOwns = value => {
  if (value === null || value === undefined) return null;
  check(Array.isArray(value) && value.every(area =>
    typeof area === "string" && area.length > 0 && area.length <= 80),
    "owns() must return an array of 1-80 char area strings or null");
  return Object.freeze([...value]);
};

// Validate one presence record from the presence source. Returns a frozen
// record, or null when the source has nothing for the agent. Presence is
// host-reported (an agent's hosts heartbeat in) — it is never self-asserted
// by the card publisher.
const PRESENCE_STATUSES = ["online", "offline", "unregistered"];
const validatePresence = record => {
  if (record === null || record === undefined) return null;
  check(record !== null && typeof record === "object", "presence() must return an object or null");
  const {
    status = "unregistered",
    lastSeenAt = null,
    hosts = 0,
  } = record;
  check(PRESENCE_STATUSES.includes(status),
    `presence.status must be one of ${PRESENCE_STATUSES.join(", ")}`);
  check(lastSeenAt === null || (typeof lastSeenAt === "number" && lastSeenAt > 0),
    "presence.lastSeenAt must be a positive number or null");
  check(Number.isInteger(hosts) && hosts >= 0,
    "presence.hosts must be a non-negative integer");
  return Object.freeze({ status, lastSeenAt, hosts });
};

// Create an agent directory. store is a caller-owned Map (agentId -> entry).
// trust is an optional function (agentId) => trust-evidence record or null,
// letting the host attach verifiable trust evidence to each card document.
// presence is an optional function (agentId) => presence record or null,
// letting the host attach live host-reported presence to each card document.
// reach is an optional function (agentId) => reach record or null, letting
// the host attach live wake/bond reachability (wake mode, last poll,
// unacked wake count, bond status, host) to each card document. owns is an
// optional function (agentId) => area/lane string array or null, letting
// the host attach the agent's live claim-derived areas to each card
// document. Without any of them, cards carry trust: null / presence: null /
// reach: null / owns: null and the surface is unchanged.
export function createAgentDirectory({ store, clock, trust, presence, reach, owns } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  check(clock === undefined || typeof clock === "function", "clock must be a function if given");
  check(trust === undefined || typeof trust === "function", "trust must be a function if given");
  check(presence === undefined || typeof presence === "function", "presence must be a function if given");
  check(reach === undefined || typeof reach === "function", "reach must be a function if given");
  check(owns === undefined || typeof owns === "function", "owns must be a function if given");
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
    // The key envelope: any reader can recompute the canonical card body
    // (see agent-card-signing.mjs) and verify the signature offline.
    publicKey: entry.publicKey ?? null,
    signature: entry.signature ?? null,
    // Host-supplied trust evidence: who approved this agent, when, with what
    // authority envelope, its current lifecycle status, and when it was last
    // seen. Null when the host supplies no trust source.
    trust: validateTrust(trust ? trust(entry.agentId) : null),
    // Host-reported presence: whether any of the agent's hosts recently
    // heartbeated, when the newest heartbeat landed, and how many hosts
    // the agent has registered. Null when the host supplies no presence
    // source (e.g. no host ever reported).
    presence: validatePresence(presence ? presence(entry.agentId) : null),
    // Host-supplied reach: how the agent is wakeable right now (wake mode
    // from live host registrations, last poll time, unacked wake count
    // from the live wake queue, bond status from live bond data, and the
    // newest host). Null when the host supplies no reach source — reach is
    // never fabricated and never self-asserted.
    reach: validateReach(reach ? reach(entry.agentId) : null),
    // Host-supplied areas/lanes derived from the agent's live claim data.
    // Null when the host supplies no owns source.
    owns: validateOwns(owns ? owns(entry.agentId) : null),
    // Provenance: "self" for agent-signed publishes, "seeded" for
    // owner-seeded cards the agent has not published yet. Lets readers tell
    // a claimed card from a placeholder.
    provenance: entry.provenance ?? "self",
    visibility: entry.visibility,
    publishedAt: entry.publishedAt,
    updatedAt: entry.updatedAt,
  });

  // Publish (or republish) a card document for an agent. publicKey/signature
  // are required: the signature must verify against publicKey over the
  // canonical card body. Rotating to a new key requires rotationSignature —
  // the old key's signature over the rotation statement — unless
  // allowRecovery (the owning identity's owner explicitly recovering a lost
  // key; the store/HTTP layer decides when that is legitimate). A stored
  // card with no pinned key yet (published before signing existed) pins the
  // new key on its next publish.
  const publish = ({ agentId, card, visibility = "public", publicKey = null, signature = null,
    rotationSignature = null, allowRecovery = false }) => {
    check(typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId),
      "agentId must match ^[a-z][a-z0-9-]*$ — this is a directory slug (e.g. 'my-agent'), not your ai_ identity id");
    check(VISIBILITIES.includes(visibility), `visibility must be one of ${VISIBILITIES.join(", ")}`);
    validateCard(card);
    if (!isValidPublicKey(publicKey)) {
      fail("invalid_card_signature",
        "publish requires publicKey (base64 Ed25519) and a valid signature over the card body");
    }
    if (!verifyCardSignature({ agentId, card, publicKey, signature })) {
      fail("invalid_card_signature", "signature does not verify against publicKey over the card body");
    }
    const existing = entries.get(agentId);
    // Chain of custody: a pinned key can only be replaced by the old key's
    // rotation signature (or an owner-signed recovery). This applies even
    // when the old card was withdrawn — withdrawing must not become a way
    // to launder a key swap. A stored card with no pinned key yet
    // (published before signing existed) pins the new key on its next
    // publish.
    if (existing && existing.publicKey && existing.publicKey !== publicKey
      && !allowRecovery
      && !verifyKeyRotation({
        agentId, card, newPublicKey: publicKey,
        oldPublicKey: existing.publicKey, rotationSignature,
      })) {
      fail("invalid_card_signature",
        "rotating the card key requires the old key's rotation signature (or an owner-signed recovery)");
    }
    const entry = {
      agentId,
      card: { ...card },
      publicKey,
      signature,
      // A signed publish is the agent speaking for itself: provenance is
      // "self", including when it replaces an owner-seeded placeholder.
      provenance: "self",
      visibility,
      publishedAt: existing?.publishedAt ?? now(),
      updatedAt: now(),
      withdrawn: false,
    };
    entries.set(agentId, entry);
    return cardDoc(entry);
  };

  // Seed a directory card for an agent that has not published one. The
  // store/HTTP layer calls this with owner authority (the agent's own key
  // is unknown); the card carries no signature and reads provenance
  // "seeded" so it is never mistaken for a self-published card. Refuses to
  // overwrite a live card — seeding is a placeholder, not a takeover. The
  // agent replaces it by publishing (signed), which flips provenance to
  // "self".
  const seed = ({ agentId, card, visibility = "room" }) => {
    check(typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId),
      "agentId must match ^[a-z][a-z0-9-]*$ — this is a directory slug (e.g. 'my-agent'), not your ai_ identity id");
    check(VISIBILITIES.includes(visibility), `visibility must be one of ${VISIBILITIES.join(", ")}`);
    validateCard(card);
    const existing = entries.get(agentId);
    if (existing && !existing.withdrawn) {
      fail("directory_seed_conflict", `a live card already exists for "${agentId}" — seeding must not overwrite it`);
    }
    const entry = {
      agentId,
      card: { ...card },
      publicKey: null,
      signature: null,
      provenance: "seeded",
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
        // A2A v1.0 shaped projection for outside-agent discoverability
        // (interop only — not orchestration).
        a2a: toA2ACard(agent, serviceOrigin),
      })),
    };
    return freezeDeep(JSON.parse(JSON.stringify(doc)));
  };

  return Object.freeze({ publish, seed, get, list, withdraw, buildDocument });
}

// A2A v1.0 Agent Card shaped projection of a directory card doc, for
// discoverability by outside (A2A-native) agents without custom
// integration. This is an INTEROP/DISCOVERABILITY layer only: the room is
// NOT an A2A JSON-RPC endpoint, and internal lane comms stay on the room
// event log + claims board. No auctions, staking/slashing, or EigenTrust —
// lanes are cooperative; first-claim-wins.
//
// Mapping notes (all honest, nothing fabricated):
// - name/description/url/version map directly. url falls back to the
//   room's directory card URL when the card has none and the origin is
//   known, else null.
// - Our capabilities[]/skills[] string arrays are what A2A calls skills,
//   so they (plus owns[] lane areas) become A2A skill objects
//   {id, name, description, tags, examples, inputModes, outputModes}.
// - A2A protocol capabilities are explicit false: we claim no A2A
//   endpoint features on the agent's behalf.
// - securitySchemes names the room's bearer credential — the honest auth
//   story for reaching the agent through the room's surfaces.
// - supportedInterfaces lists the room's HTTP+JSON and MCP surfaces, only
//   when serviceOrigin is known.
// - signatures[] is deliberately ABSENT. Per-agent cards use the house
//   Ed25519 signature (publicKey/signature over the canonical card body),
//   not JWS — presenting it as A2A signatures[] would be unverifiable and
//   dishonest. Signing is a SHOULD; the unsigned projection is spec-valid.
//   Verification rides on x-project-room.signature instead.
const a2aSlug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";

export function toA2ACard(doc, serviceOrigin = null) {
  check(doc !== null && typeof doc === "object", "doc must be a card document object");
  check(serviceOrigin === null || (typeof serviceOrigin === "string" && /^https:\/\/\S+$/.test(serviceOrigin)),
    "serviceOrigin must be an https URL or null");
  const skills = [];
  const seenSkill = new Set();
  const addSkill = (id, name, description, tags) => {
    if (seenSkill.has(id)) return;
    seenSkill.add(id);
    skills.push(Object.freeze({
      id, name, description,
      tags: Object.freeze([...tags]),
      examples: Object.freeze([]),
      inputModes: Object.freeze(["text/plain"]),
      outputModes: Object.freeze(["text/plain"]),
    }));
  };
  for (const capability of doc.capabilities ?? []) {
    addSkill(`capability-${a2aSlug(capability)}`, String(capability),
      `Advertised lane capability: ${capability}.`, [String(capability)]);
  }
  for (const skill of doc.skills ?? []) {
    addSkill(`skill-${a2aSlug(skill)}`, String(skill),
      `Advertised lane skill: ${skill}.`, [String(skill)]);
  }
  for (const area of doc.owns ?? []) {
    addSkill(`lane-${a2aSlug(area)}`, `Lane: ${area}`,
      `Active lane area derived from this agent's live work claims.`, [String(area), "lane"]);
  }
  const cardUrl = serviceOrigin ? `${serviceOrigin}/api/agents/directory/${doc.agentId}` : null;
  const projection = {
    name: doc.name,
    description: doc.description,
    url: doc.url ?? cardUrl,
    version: doc.version,
    capabilities: Object.freeze({
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    }),
    defaultInputModes: Object.freeze(["text/plain"]),
    defaultOutputModes: Object.freeze(["text/plain"]),
    skills: Object.freeze(skills),
    securitySchemes: Object.freeze({
      roomCredential: Object.freeze({
        type: "http",
        scheme: "bearer",
        description: "Room credential: a room token or session cookie on the room's HTTP/MCP surfaces. The agent is reached through the room, not directly.",
      }),
    }),
    "x-project-room": Object.freeze({
      agentId: doc.agentId,
      provenance: doc.provenance ?? "self",
      visibility: doc.visibility,
      owns: doc.owns ?? null,
      reach: doc.reach ?? null,
      directory: serviceOrigin ? `${serviceOrigin}/api/agent-directory` : null,
      cardUrl,
      signature: Object.freeze({
        algorithm: "Ed25519",
        publicKey: doc.publicKey ?? null,
        signature: doc.signature ?? null,
        signedBytes: "canonical-card-body-v1",
        guide: "docs/SIGNED-AGENT-CARDS.md",
      }),
      note: "Interop/discoverability projection of the room directory card. Internal lane coordination stays on the room event log + claims board; this card does not imply A2A JSON-RPC support.",
    }),
  };
  if (serviceOrigin) {
    projection.supportedInterfaces = Object.freeze([
      Object.freeze({ url: `${serviceOrigin}/api/agent-directory`, protocolBinding: "HTTP+JSON" }),
      Object.freeze({ url: `${serviceOrigin}/mcp`, protocolBinding: "MCP" }),
    ]);
  }
  return freezeDeep(projection);
}
export { DirectoryError };
