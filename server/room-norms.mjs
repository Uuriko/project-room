// Room coordination norms as server-side config defaults.
//
// Three norms keep multi-agent rooms collision-free and quiet:
//
//   maxClaimsPerAgentPerCycle (default 1) — one task claimed per work cycle
//     per agent. Enforced in the claim path where feasible: agents call
//     assertClaimAllowed() before claimWork() (server/work-claims.mjs, the
//     anti-collision state machine). It counts the agent's concurrent active
//     claims as the enforceable proxy for "per cycle"; the server event layer
//     (src/events.js acquireClaim) does not consult it, so there it is
//     documented as advisory via the activation pack.
//
//   releaseOnInactivityHours (default 24) — claims auto-release after this
//     many hours of owner inactivity. staleClaims() lists the release
//     candidates by reading last activity: the work-claims history stamps, or
//     the event model's updatedAt / claim.acquiredAt. This hooks into the
//     lease semantics: the same sweep that retires expired claim.expiresAt
//     leases (src/events.js claimIsActive) is the natural place to release
//     inactive claims too.
//
//   stopAfterRepeatedNoopWakes (default 5) — guidance surfaced for agents:
//     stop wake/work-polling after this many consecutive no-op cycles.
//     Advisory only (the server cannot observe an agent's poll loop); it
//     ships in the coordinationNorms block and the shouldStopWaking() helper.
//
// Norms are room-configurable: the room owner may override per room via
// setRoomNorms() (resetRoomNorms() restores defaults). Rooms without an
// override get DEFAULT_NORMS automatically, so every new room ships with the
// defaults — no migration, no seeding step.
//
// JSON shape for the room activation pack (the activation-pack endpoint
// includes it under "coordinationNorms"):
//   { "coordinationNorms": {
//       "maxClaimsPerAgentPerCycle": 1,
//       "releaseOnInactivityHours": 24,
//       "stopAfterRepeatedNoopWakes": 5,
//       "customized": false } }
// `customized` is true when the room owner overrode at least one norm.
//
// Pure and dependency-free; per-room overrides live in a module-level map.
// Durable persistence of overrides is a later slice (server/work-claims.mjs
// carries the same note for work persistence).

export const DEFAULT_NORMS = Object.freeze({
  maxClaimsPerAgentPerCycle: 1,
  releaseOnInactivityHours: 24,
  stopAfterRepeatedNoopWakes: 5,
});
export const NORM_KEYS = Object.freeze(Object.keys(DEFAULT_NORMS));

export const NORM_DESCRIPTIONS = Object.freeze({
  maxClaimsPerAgentPerCycle:
    "One task claimed per work cycle per agent. Enforced in the agent claim path " +
    "(guard: assertClaimAllowed before claimWork in server/work-claims.mjs); " +
    "advisory at the server event layer, stated in the activation pack.",
  releaseOnInactivityHours:
    "Claims auto-release after this many hours of owner inactivity. " +
    "Hook into the lease-expiry sweep alongside expired claim.expiresAt leases " +
    "(src/events.js claimIsActive).",
  stopAfterRepeatedNoopWakes:
    "Guidance: stop wake/work-polling after this many consecutive no-op cycles. " +
    "Advisory only — surfaced to agents via the activation pack.",
});

const NORM_BOUNDS = Object.freeze({
  maxClaimsPerAgentPerCycle: { min: 1, max: 10, integer: true },
  releaseOnInactivityHours: { min: 1, max: 720, integer: false },
  stopAfterRepeatedNoopWakes: { min: 1, max: 100, integer: true },
});

export class NormsError extends Error {
  constructor(code, message) { super(message); this.name = "NormsError"; this.code = code; }
}
const fail = (code, message) => { throw new NormsError(code, message); };
const checkRoomId = roomId => {
  if (typeof roomId !== "string" || roomId.length === 0 || roomId.length > 128) {
    fail("norms_invalid_input", "roomId must be a 1..128 character string");
  }
  return roomId;
};
const checkItems = items => {
  if (!Array.isArray(items)) fail("norms_invalid_input", "work items must be a list");
  return items;
};
const checkAgent = agentId => {
  if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 128) {
    fail("norms_invalid_input", "agent id must be a 1..128 character string");
  }
  return agentId;
};

export function validateNormPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    fail("norms_invalid_patch", "norm patch must be an object");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) fail("norms_invalid_patch", "norm patch must change at least one norm");
  const clean = {};
  for (const key of keys) {
    const bounds = NORM_BOUNDS[key];
    if (!bounds) fail("norms_invalid_patch", `unknown norm "${key}" — expected one of ${NORM_KEYS.join(", ")}`);
    const value = patch[key];
    const bad = typeof value !== "number" || !Number.isFinite(value)
      || (bounds.integer && !Number.isInteger(value)) || value < bounds.min || value > bounds.max;
    if (bad) {
      fail("norms_invalid_patch",
        `"${key}" must be ${bounds.integer ? "an integer" : "a number"} between ${bounds.min} and ${bounds.max}`);
    }
    clean[key] = value;
  }
  return Object.freeze(clean);
}

// Per-room owner overrides; absent rooms merge to DEFAULT_NORMS on read.
const overrides = new Map();

export function getRoomNorms(roomId) {
  checkRoomId(roomId);
  return Object.freeze({ ...DEFAULT_NORMS, ...overrides.get(roomId) });
}

// The block the room activation-pack endpoint includes under "coordinationNorms".
export function coordinationNormsBlock(roomId) {
  checkRoomId(roomId);
  const patch = overrides.get(roomId);
  return Object.freeze({
    coordinationNorms: Object.freeze({ ...getRoomNorms(roomId), customized: patch !== undefined }),
  });
}

// Owner-only: merge a validated patch of norm values for one room.
export function setRoomNorms(roomId, patch, { isOwner } = {}) {
  checkRoomId(roomId);
  if (isOwner !== true) fail("norms_not_owner", "Only the room owner may change coordination norms");
  const clean = validateNormPatch(patch);
  overrides.set(roomId, { ...overrides.get(roomId), ...clean });
  return getRoomNorms(roomId);
}

// Owner-only: drop a room's overrides so the defaults apply again.
export function resetRoomNorms(roomId, { isOwner } = {}) {
  checkRoomId(roomId);
  if (isOwner !== true) fail("norms_not_owner", "Only the room owner may change coordination norms");
  overrides.delete(roomId);
  return getRoomNorms(roomId);
}

const resolveNorms = norms =>
  (norms === undefined ? DEFAULT_NORMS : Object.freeze({ ...DEFAULT_NORMS, ...validateNormPatchLoose(norms) }));
const validateNormPatchLoose = norms => {
  if (!norms || typeof norms !== "object" || Array.isArray(norms)) fail("norms_invalid_input", "norms must be an object");
  const known = {};
  for (const key of Object.keys(norms)) {
    if (!NORM_BOUNDS[key]) fail("norms_invalid_input", `unknown norm "${key}"`);
    known[key] = norms[key];
  }
  return known;
};

// Work-item normalization across the two claim models:
//  - the work-claims state machine (server/work-claims.mjs): { id, owner, state, history: [{ at }] }
//  - the event-sourced room model (src/events.js): { id, state, updatedAt, claim: { holderId, status, acquiredAt } }
const TERMINAL_STATES = new Set(["done", "completed", "superseded", "unclaimed"]);

const ownerOf = item => {
  if (typeof item?.owner === "string" && item.owner.length > 0) return item.owner;
  const claim = item?.claim;
  if (claim && claim.status === "active" && typeof claim.holderId === "string" && claim.holderId.length > 0) {
    return claim.holderId;
  }
  return null;
};

const isActiveClaim = item => ownerOf(item) !== null && !TERMINAL_STATES.has(item?.state);

const lastActivityOf = item => {
  const stamps = [];
  if (Array.isArray(item?.history)) for (const entry of item.history) stamps.push(entry?.at);
  if (typeof item?.updatedAt === "string") stamps.push(item.updatedAt);
  if (typeof item?.claim?.acquiredAt === "string") stamps.push(item.claim.acquiredAt);
  const times = stamps.map(stamp => Date.parse(stamp)).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
};

// Claim-path guard: refuse a new claim when the agent already holds
// maxClaimsPerAgentPerCycle active claims. Returns the current active count
// when the claim may proceed. Call before claimWork() — that is the enforced
// location; the server event layer stays advisory (see module header).
export function assertClaimAllowed(items, agentId, { norms } = {}) {
  checkItems(items); checkAgent(agentId);
  const limit = resolveNorms(norms).maxClaimsPerAgentPerCycle;
  const active = items.filter(item => isActiveClaim(item) && ownerOf(item) === agentId).length;
  if (active >= limit) {
    fail("norm_claim_limit",
      `agent "${agentId}" already holds ${active} active claim(s) — the room norm allows ` +
      `${limit} per work cycle; release or finish one before claiming more`);
  }
  return active;
}

// Inactivity-release hook: work items whose owner has been inactive longer
// than releaseOnInactivityHours. Feed these to the same sweep that expires
// claim.expiresAt leases (src/events.js claimIsActive).
export function staleClaims(items, { norms, now } = {}) {
  checkItems(items);
  const hours = resolveNorms(norms).releaseOnInactivityHours;
  const cutoff = (now === undefined ? Date.now() : now) - hours * 60 * 60 * 1000;
  return items.filter(item => {
    if (!isActiveClaim(item)) return false;
    const last = lastActivityOf(item);
    return last !== null && last < cutoff;
  });
}

// No-op-wake guidance: true when the agent should stop wake/work-polling.
// Advisory only — the server cannot observe an agent's poll loop.
export function shouldStopWaking(noopWakeCount, { norms } = {}) {
  if (!Number.isInteger(noopWakeCount) || noopWakeCount < 0) {
    fail("norms_invalid_input", "noop wake count must be a non-negative integer");
  }
  return noopWakeCount >= resolveNorms(norms).stopAfterRepeatedNoopWakes;
}
