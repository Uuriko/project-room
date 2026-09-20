// Work claims (B006/B007). A pure work-item state machine for agent
// coordination: work starts unclaimed; an agent claims it (claimed), starts
// it (in_progress), and finishes it (done) or marks it blocked. Only the
// claiming agent may update, release, or reassign its work — anyone else's
// attempt is refused, never half-applied. This is the anti-collision core:
// two agents cannot both own the same work item. Pure, dependency-free,
// deterministic; frozen outputs. Persistence is a later slice.
//
// Claim leases: a claim may carry a lease (default 24h). A claimed item
// records claimedAt + leaseExpiresAt; isLeaseExpired(work, now) reports
// whether the lease has lapsed, and releaseExpired(items, now) auto-releases
// expired claims back to unclaimed (owner cleared, history stamped). Pass
// leaseHours to claimWork, or null to opt out of leases entirely — claims
// without a lease behave exactly as before (never expire). Leases are
// configurable per room: a room object carrying
//   room.workClaims = { defaultLeaseHours, reviewPolicy }
// overrides the defaults; see roomWorkClaimConfig. The default lease cap is
// 720h (30 days).
//
// Delivery modes: the done transition accepts { deliveryMode } in
// { result, merged, production } — how the work was delivered — persisted on
// the item and stamped into history.
//
// Review policies: work items (or the room config) carry reviewPolicy in
// { self_attested, distinct_member, independent_principal }. canCloseWork
// enforces the policy for the done transition: self_attested lets the
// claimant close; distinct_member requires a different member to attest;
// independent_principal requires a different member holding the verify
// permission (supplied as verifyMembers) to attest. Enforcement lives with
// the caller (the HTTP layer applies it); the state machine itself only
// records the attestation (reviewedBy) on the done transition.
//
// SECURITY (QA-Sec 2026-09-19): attestations are first-class records, not
// caller-supplied names. attestWork records a review attestation from the
// authenticated caller's own session; the done transition only accepts a
// reviewedBy that has such a recorded attestation (for non-self policies).
// Naming another member without their attestation is rejected — the
// previous "name anyone" behavior was a confused-deputy flaw.
const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done"];
const TRANSITIONS = {
  unclaimed: ["claimed"],
  claimed: ["in_progress", "blocked", "unclaimed"], // unclaimed = release
  in_progress: ["blocked", "done", "claimed"],       // claimed = pause
  blocked: ["in_progress", "claimed"],
  done: [],
};
const DELIVERY_MODES = ["result", "merged", "production"];
const REVIEW_POLICIES = ["self_attested", "distinct_member", "independent_principal"];
const DEFAULT_LEASE_HOURS = 24;
const MAX_LEASE_HOURS = 720;
const DEFAULT_REVIEW_POLICY = "self_attested";
const ACTIVE_CLAIM_STATES = ["claimed", "in_progress", "blocked"];
class ClaimError extends Error { constructor(code, message) { super(message); this.name = "ClaimError"; this.code = code; } }
const fail = (code, message) => { throw new ClaimError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_claim_input", message); };

const toMs = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") { const ms = Date.parse(value); check(Number.isFinite(ms), "now must be a ms epoch, Date, or ISO timestamp"); return ms; }
  fail("invalid_claim_input", "now must be a ms epoch, Date, or ISO timestamp");
};
const nowMsOf = value => value === undefined ? Date.now() : toMs(value);
const isoOf = ms => new Date(ms).toISOString();
const idOf = (value, what, max) => {
  check(typeof value === "string" && value.length > 0 && value.length <= max, `${what} must be 1..${max} characters`);
  return value;
};

const attestationOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "attestation must be an object");
  check(typeof value.memberId === "string" && value.memberId.length > 0 && value.memberId.length <= 128, "attestation memberId must be 1..128 characters");
  check(typeof value.at === "string" && Number.isFinite(Date.parse(value.at)), "attestation at must be an ISO timestamp");
  if (value.note !== undefined && value.note !== null) check(typeof value.note === "string" && value.note.length <= 512, "attestation note must be at most 512 characters");
  return Object.freeze({ memberId: value.memberId, at: value.at, note: value.note ?? null });
};

const workOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "work must be an object");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256, "work id must be 1..256 characters");
  check(value.state === undefined || STATES.includes(value.state), `state must be one of ${STATES.join(", ")}`);
  if (value.claimedAt !== undefined && value.claimedAt !== null) check(typeof value.claimedAt === "string" && Number.isFinite(Date.parse(value.claimedAt)), "claimedAt must be an ISO timestamp");
  if (value.leaseExpiresAt !== undefined && value.leaseExpiresAt !== null) check(typeof value.leaseExpiresAt === "string" && Number.isFinite(Date.parse(value.leaseExpiresAt)), "leaseExpiresAt must be an ISO timestamp");
  if (value.deliveryMode !== undefined && value.deliveryMode !== null) check(DELIVERY_MODES.includes(value.deliveryMode), `deliveryMode must be one of ${DELIVERY_MODES.join(", ")}`);
  if (value.reviewPolicy !== undefined && value.reviewPolicy !== null) check(REVIEW_POLICIES.includes(value.reviewPolicy), `reviewPolicy must be one of ${REVIEW_POLICIES.join(", ")}`);
  if (value.reviewedBy !== undefined && value.reviewedBy !== null) check(typeof value.reviewedBy === "string" && value.reviewedBy.length > 0 && value.reviewedBy.length <= 128, "reviewedBy must be 1..128 characters");
  const attestations = Array.isArray(value.attestations) ? value.attestations.map(attestationOf) : [];
  return { id: value.id, title: value.title ?? value.id, state: value.state ?? "unclaimed",
    owner: value.owner ?? null, history: Array.isArray(value.history) ? value.history : [],
    claimedAt: value.claimedAt ?? null, leaseExpiresAt: value.leaseExpiresAt ?? null,
    deliveryMode: value.deliveryMode ?? null, reviewPolicy: value.reviewPolicy ?? null,
    reviewedBy: value.reviewedBy ?? null, attestations: Object.freeze(attestations) };
};
const agentOf = value => idOf(value, "agent id", 128);
const stamp = (atMs, agentId, action, note) =>
  Object.freeze({ at: isoOf(atMs), agentId, action, note: note ?? null });
const withHistory = (work, atMs, agentId, action, note) =>
  Object.freeze({ ...work, history: Object.freeze([...work.history, stamp(atMs, agentId, action, note)]) });
// Room config hook: resolve per-room work-claim defaults from an optional
// room object. Rooms opt in by carrying workClaims = { defaultLeaseHours,
// reviewPolicy }; anything missing or invalid falls back to the defaults.
export function roomWorkClaimConfig(room) {
  const raw = room?.workClaims ?? {};
  const defaultLeaseHours = typeof raw.defaultLeaseHours === "number" && raw.defaultLeaseHours > 0 && raw.defaultLeaseHours <= MAX_LEASE_HOURS
    ? raw.defaultLeaseHours : DEFAULT_LEASE_HOURS;
  const reviewPolicy = REVIEW_POLICIES.includes(raw.reviewPolicy) ? raw.reviewPolicy : DEFAULT_REVIEW_POLICY;
  return Object.freeze({ defaultLeaseHours, reviewPolicy });
}
const leaseHoursOf = value => {
  if (value === null || value === undefined) return value; // null = explicit opt-out of leases
  check(typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_LEASE_HOURS,
    `leaseHours must be > 0 and <= ${MAX_LEASE_HOURS}, or null for no lease`);
  return value;
};
// Create a work item (unclaimed). Items usually enter the registry here;
// claiming an unknown id is refused so claims always reference real work.
export function createWork({ id, title, reviewPolicy, note } = {}, { now } = {}) {
  const atMs = nowMsOf(now);
  idOf(id, "work id", 256);
  if (title !== undefined) check(typeof title === "string" && title.length > 0 && title.length <= 512, "title must be 1..512 characters");
  if (reviewPolicy !== undefined && reviewPolicy !== null) check(REVIEW_POLICIES.includes(reviewPolicy), `reviewPolicy must be one of ${REVIEW_POLICIES.join(", ")}`);
  const item = { id, title: title ?? id, state: "unclaimed", owner: null, history: [],
    claimedAt: null, leaseExpiresAt: null, deliveryMode: null,
    reviewPolicy: reviewPolicy ?? null, reviewedBy: null, attestations: Object.freeze([]) };
  return withHistory(item, atMs, "system", "created", note);
}
// Claim unclaimed work. Refuses already-claimed work (the anti-collision rule).
// leaseHours: hours until the claim lapses (default: the room's
// defaultLeaseHours, else 24h); null opts out — the claim never expires.
export function claimWork(work, agentId, { note, leaseHours, room, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(item.state === "unclaimed", `work "${item.id}" is already ${item.state} — release it first`);
  const wanted = leaseHoursOf(leaseHours);
  const effective = wanted === null ? null : wanted ?? roomWorkClaimConfig(room).defaultLeaseHours;
  const claimed = { ...item, state: "claimed", owner: agent, claimedAt: isoOf(atMs),
    leaseExpiresAt: effective === null ? null : isoOf(atMs + effective * 3600 * 1000) };
  return withHistory(claimed, atMs, agent, "claimed",
    effective === null ? note : note ?? `lease: ${effective}h`);
}
// Update claimed work: move state or add a note. Only the owner may update.
// The done transition accepts deliveryMode (how the work was delivered) and
// reviewedBy (the attesting member, per the item's review policy).
export function updateWork(work, agentId, { state, note, deliveryMode, reviewedBy, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can update it`);
  check(item.state !== "done", `work "${item.id}" is done and immutable`);
  if (state !== undefined) {
    check(STATES.includes(state), `state must be one of ${STATES.join(", ")}`);
    check(TRANSITIONS[item.state].includes(state), `cannot move "${item.id}" from ${item.state} to ${state}`);
  }
  if (deliveryMode !== undefined && deliveryMode !== null) {
    check(state === "done", "deliveryMode is only recorded on the done transition");
    check(DELIVERY_MODES.includes(deliveryMode), `deliveryMode must be one of ${DELIVERY_MODES.join(", ")}`);
  }
  if (reviewedBy !== undefined && reviewedBy !== null) {
    check(state === "done", "reviewedBy is only recorded on the done transition");
    agentOf(reviewedBy);
  }
  const released = state === "unclaimed";
  const next = state === undefined ? item : { ...item, state,
    owner: released ? null : item.owner,
    leaseExpiresAt: released ? null : item.leaseExpiresAt, // a released claim holds no lease
    // a released claim drops its reviews too — attestations belong to the
    // lapsed owner's round of work, never to whoever claims next
    attestations: released ? Object.freeze([]) : item.attestations,
    deliveryMode: state === "done" && deliveryMode != null ? deliveryMode : item.deliveryMode,
    reviewedBy: state === "done" && reviewedBy != null ? reviewedBy : item.reviewedBy };
  return withHistory(next, atMs, agent, state === undefined ? "noted" : `state:${state}`, note);
}
// Record a review attestation from the caller's own authenticated session.
// One attestation per member (latest wins); the done transition consults
// these records rather than trusting a caller-supplied reviewedBy name.
// Refused on unclaimed work (nothing to review) and on done work (immutable).
export function attestWork(work, agentId, { note, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), atMs = nowMsOf(now);
  check(ACTIVE_CLAIM_STATES.includes(item.state), `work "${item.id}" is ${item.state} — only active claims can be reviewed`);
  if (note !== undefined && note !== null) check(typeof note === "string" && note.length <= 512, "note must be at most 512 characters");
  const attestation = Object.freeze({ memberId: agent, at: isoOf(atMs), note: note ?? null });
  const attestations = Object.freeze([
    ...item.attestations.filter(entry => entry.memberId !== agent),
    attestation,
  ]);
  return withHistory({ ...item, attestations }, atMs, agent, "reviewed", note);
}
// Reassign: the owner hands work to another agent (stays in the same state).
// Attestations are cleared — reviews belong to the previous owner's round.
export function reassignWork(work, agentId, newOwner, { note, now } = {}) {
  const item = workOf(work), agent = agentOf(agentId), target = agentOf(newOwner), atMs = nowMsOf(now);
  check(item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can reassign it`);
  check(item.state !== "done", `work "${item.id}" is done and immutable`);
  return withHistory({ ...item, owner: target, attestations: Object.freeze([]) }, atMs, agent, `reassigned:${target}`, note);
}
// True when the item holds an active claim whose lease has lapsed. Items
// without a lease, and items not under claim, never expire.
export function isLeaseExpired(work, now) {
  const item = workOf(work);
  if (!ACTIVE_CLAIM_STATES.includes(item.state) || item.leaseExpiresAt === null) return false;
  return Date.parse(item.leaseExpiresAt) <= nowMsOf(now);
}
// Sweep a list: expired claims are auto-released to unclaimed (owner
// cleared, lease cleared, history stamped). Everything else passes through
// untouched. Returns a new list; inputs are never mutated.
export function releaseExpired(items, now) {
  check(Array.isArray(items), "items must be a list");
  const atMs = nowMsOf(now);
  return items.map(entry => {
    const item = workOf(entry);
    if (!isLeaseExpired(item, atMs)) return item;
    const released = { ...item, state: "unclaimed", owner: null, leaseExpiresAt: null };
    return withHistory(released, atMs, item.owner ?? "system", "lease_expired",
      `claim by ${item.owner ?? "nobody"} lapsed at ${item.leaseExpiresAt} — auto-released`);
  });
}
// Review-policy gate for the done transition. policy resolves from the
// explicit option, then the work item, then self_attested. verifyMembers is
// the set/list of member ids holding the verify permission (only consulted
// for independent_principal). Returns true when reviewerId may close the
// work; unknown policies throw (programmer error), identity mismatches
// simply return false.
export function canCloseWork(work, reviewerId, { policy, verifyMembers } = {}) {
  const item = workOf(work);
  const effective = policy ?? item.reviewPolicy ?? DEFAULT_REVIEW_POLICY;
  check(REVIEW_POLICIES.includes(effective), `policy must be one of ${REVIEW_POLICIES.join(", ")}`);
  if (item.state === "done" || item.state === "unclaimed" || item.owner === null) return false;
  if (typeof reviewerId !== "string" || reviewerId.length === 0) return false;
  if (effective === "self_attested") return reviewerId === item.owner;
  if (reviewerId === item.owner) return false;
  if (effective === "distinct_member") return true;
  const verifiers = verifyMembers instanceof Set ? verifyMembers : new Set(verifyMembers ?? []);
  return verifiers.has(reviewerId);
}
// Query helpers over a list.
export function workOwnedBy(items, agentId) {
  check(Array.isArray(items), "items must be a list");
  const agent = agentOf(agentId);
  return items.map(workOf).filter(item => item.owner === agent && item.state !== "done");
}
export function unclaimedWork(items) {
  check(Array.isArray(items), "items must be a list");
  return items.map(workOf).filter(item => item.state === "unclaimed");
}
export { ClaimError, STATES, TRANSITIONS, DELIVERY_MODES, REVIEW_POLICIES, DEFAULT_LEASE_HOURS, MAX_LEASE_HOURS };
