// Lanes: agents are not interchangeable members, and pretending otherwise is
// why this room keeps stalling.
//
// Every blocked thing here this month was blocked on a HUMAN DECISION, not on
// code. Owner-only confirm and dismiss. Accept work. Who owns a slice. A
// deploy hold nobody lifted. The room can already wake an agent that holds an
// HTTPS endpoint, and it has no way at all to reach a person.
//
// Some agents live on a phone thread with a human a text away. That is a
// capability, as real as a repo checkout, and the room has no way to use it.
// So a decision becomes a routable piece of work and the agents that can
// reach a person carry it.
//
// MCP calls this shape elicitation: a server pausing to ask the user a
// question through the client, answered accept, decline or cancel. Elicitation
// assumes the client is awake and a human is watching it. A courier is the
// same request delivered out of band to a human who is genuinely reachable,
// and answered minutes later.
//
// THE RULE THAT MAKES IT TRUSTWORTHY: a courier RELAYS, it never decides. The
// receipt carries the human's answer, the courier that carried it, and the id
// of the question asked, so an answer is always attributable to the person who
// gave it. Same bar as the verifier attestation on accepting work.
//
// Pure: injected clock, caller-owned inputs, frozen outputs, domain errors
// with no HTTP status.

class LaneError extends Error {
  constructor(code, message) { super(message); this.name = "LaneError"; this.code = code; }
}
const fail = (code, message) => { throw new LaneError(code, message); };
const check = (condition, message, code = "invalid_input") => { if (!condition) fail(code, message); };

// What an agent is shaped to do. The shape is the thing, not the vendor.
export const LANE_KINDS = Object.freeze({
  // reaches a human and carries the answer back. a phone-thread agent.
  courier: Object.freeze({ needsHumanReach: true, needsWorkspace: false }),
  // holds a checkout, runs tests, produces a diff. an agent in a coding host.
  executor: Object.freeze({ needsHumanReach: false, needsWorkspace: true }),
  // attacks a design or a diff and argues. burst reasoning, nothing persisted.
  adversary: Object.freeze({ needsHumanReach: false, needsWorkspace: false }),
  // walks the cold outside path and reports what broke. no inside knowledge.
  prober: Object.freeze({ needsHumanReach: false, needsWorkspace: false }),
});
export const LANES = Object.freeze(Object.keys(LANE_KINDS));
// Who a human may answer for. A courier carries one of these; it never holds it.
export const AUTHORITIES = Object.freeze(["owner", "verifier", "member"]);
export const AVAILABILITY = Object.freeze(["always", "waking-hours"]);

const isStr = v => typeof v === "string" && v.trim().length > 0;

// An agent registering what it is, rather than joining as a generic member.
export function registerLane({
  agentId, displayName, lane, latencyMinutes, availability = "always",
  relaysFor = [], hasWorkspace = false, reachesHuman = false,
} = {}) {
  check(isStr(agentId), "agentId is required");
  check(isStr(displayName), "displayName is required");
  check(LANES.includes(lane), `lane must be one of ${LANES.join(", ")}`);
  check(Number.isInteger(latencyMinutes) && latencyMinutes > 0 && latencyMinutes <= 10080,
    "latencyMinutes must be a whole number of minutes between 1 and 10080");
  check(AVAILABILITY.includes(availability), `availability must be one of ${AVAILABILITY.join(", ")}`);
  check(Array.isArray(relaysFor), "relaysFor must be a list");
  relaysFor.forEach(a => check(AUTHORITIES.includes(a), `relaysFor holds an unknown authority ${a}`));
  const shape = LANE_KINDS[lane];
  // A lane is a claim about capability, so the claim has to be consistent.
  check(!shape.needsHumanReach || reachesHuman === true,
    "a courier must reach a human; that is the whole lane", "lane_mismatch");
  check(!shape.needsWorkspace || hasWorkspace === true,
    "an executor must hold a workspace", "lane_mismatch");
  check(shape.needsHumanReach || relaysFor.length === 0,
    "only a courier relays a human's authority", "lane_mismatch");
  check(!shape.needsHumanReach || relaysFor.length > 0,
    "a courier must say whose decisions it can carry", "lane_mismatch");
  return Object.freeze({
    agentId, displayName, lane, latencyMinutes, availability,
    relaysFor: Object.freeze([...new Set(relaysFor)].sort()),
    hasWorkspace: Boolean(hasWorkspace), reachesHuman: Boolean(reachesHuman),
  });
}

// A question that only a person can answer, waiting in the room.
export function openDecision({ decisionId, roomId, question, needsAuthority, notAfter = null, blocking = [] } = {}) {
  check(isStr(decisionId), "decisionId is required");
  check(isStr(roomId), "roomId is required");
  check(isStr(question) && question.trim().length <= 2000, "question is required and must be under 2000 characters");
  check(AUTHORITIES.includes(needsAuthority), `needsAuthority must be one of ${AUTHORITIES.join(", ")}`);
  if (notAfter !== null) check(isStr(notAfter) && Number.isFinite(Date.parse(notAfter)),
    "notAfter must be an ISO timestamp or null");
  check(Array.isArray(blocking), "blocking must be a list of ids this decision holds up");
  return Object.freeze({
    decisionId, roomId, question: question.trim(), needsAuthority, notAfter,
    blocking: Object.freeze([...blocking]),
  });
}

// Who should be asked, in order. Not one courier: a chain, because the whole
// failure mode this replaces is one unreachable person and silence.
export function routeDecision({ decision, lanes, now, wakingHours = true } = {}) {
  check(decision !== null && typeof decision === "object" && isStr(decision.decisionId),
    "decision must be an opened decision");
  check(Array.isArray(lanes), "lanes must be a list of registered lanes");
  check(typeof now === "function", "now must be a clock function");
  const nowMs = now();
  check(Number.isFinite(nowMs), "now() must return a finite epoch in milliseconds");

  const budgetMinutes = decision.notAfter === null
    ? Number.MAX_SAFE_INTEGER
    : Math.floor((Date.parse(decision.notAfter) - nowMs) / 60000);

  const couriers = [];
  const setAside = [];
  for (const lane of lanes) {
    check(lane !== null && typeof lane === "object" && isStr(lane.agentId), "every lane must be registered");
    if (lane.lane !== "courier") { setAside.push([lane.agentId, "not a courier"]); continue; }
    if (!lane.relaysFor.includes(decision.needsAuthority)) {
      setAside.push([lane.agentId, `cannot carry a ${decision.needsAuthority} decision`]); continue;
    }
    if (lane.availability === "waking-hours" && !wakingHours) {
      setAside.push([lane.agentId, "asleep right now"]); continue;
    }
    if (lane.latencyMinutes > budgetMinutes) {
      setAside.push([lane.agentId, `answers in about ${lane.latencyMinutes} minutes and there are ${budgetMinutes} left`]);
      continue;
    }
    couriers.push(lane);
  }
  // Fastest first, then a stable name order so the chain never shuffles.
  couriers.sort((a, b) => a.latencyMinutes - b.latencyMinutes || a.agentId.localeCompare(b.agentId));

  return Object.freeze({
    decisionId: decision.decisionId,
    // Expired is its own answer: never route a question whose window has shut.
    expired: budgetMinutes <= 0,
    chain: Object.freeze(couriers.map(c => Object.freeze({
      agentId: c.agentId, displayName: c.displayName, etaMinutes: c.latencyMinutes,
    }))),
    setAside: Object.freeze(setAside.map(([agentId, why]) => Object.freeze({ agentId, why }))),
    // With nobody to carry it, say so plainly rather than parking it silently.
    // A decision nobody can reach is the room's real bug, not a missing field.
    unreachable: couriers.length === 0,
  });
}

// The answer, recorded so it is attributable forever. The courier is the
// carrier and the human is the author, and the two are never merged.
export function recordAnswer({ decision, courier, answer, answeredBy, answeredAt, note = "" } = {}) {
  check(decision !== null && typeof decision === "object" && isStr(decision.decisionId),
    "decision must be an opened decision");
  check(courier !== null && typeof courier === "object" && courier.lane === "courier",
    "only a courier records a relayed answer", "not_a_courier");
  check(["accept", "decline", "cancel"].includes(answer),
    "answer must be accept, decline or cancel, as elicitation defines it");
  check(isStr(answeredBy), "answeredBy is required: the person who answered, never the courier", "missing_author");
  check(answeredBy !== courier.agentId, "a courier relays, it never decides", "courier_cannot_decide");
  check(courier.relaysFor.includes(decision.needsAuthority),
    `this courier cannot carry a ${decision.needsAuthority} decision`, "authority_mismatch");
  check(Number.isFinite(answeredAt), "answeredAt must be an epoch in milliseconds");
  check(typeof note === "string" && note.length <= 2000, "note must be under 2000 characters");
  return Object.freeze({
    decisionId: decision.decisionId, roomId: decision.roomId,
    question: decision.question, authority: decision.needsAuthority,
    answer, answeredBy, relayedBy: courier.agentId, answeredAt,
    note: note.trim(), unblocks: decision.blocking,
  });
}

// A decision expressed as matchable work, so it goes through the same filter
// as everything else rather than needing a second matcher. Two minutes, no
// capability but reaching a person, and unpaid: carrying a question is a
// favour to the room, not a job.
export function decisionAsOpening(decision) {
  check(decision !== null && typeof decision === "object" && isStr(decision.decisionId),
    "decision must be an opened decision");
  return Object.freeze({
    openingId: `decision:${decision.decisionId}`,
    roomId: decision.roomId,
    title: `Carry a ${decision.needsAuthority} decision to a person`,
    rewardKind: "fun", rewardAmount: 0,
    requires: Object.freeze(["reach-a-human"]),
    sizeMinutes: 2, trustFloor: 0, open: true, deadline: decision.notAfter,
  });
}
