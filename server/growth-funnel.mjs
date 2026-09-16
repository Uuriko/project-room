// Growth funnel (G008): invite → join → first work item. A pure funnel
// analysis over a supplied list of room events: for each agent it finds the
// first invite, the first join, and the first work event (claim/update/post),
// then reports stage counts, conversion rates, and median time-to-stage.
// The caller supplies the events — no store reads. Pure, dependency-free,
// deterministic; frozen outputs. Funnel UI is a later slice.
const WORK_TYPES = ["work.claim", "work.update", "room.post"];
class FunnelError extends Error { constructor(code, message) { super(message); this.name = "FunnelError"; this.code = code; } }
const fail = (code, message) => { throw new FunnelError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_funnel_input", message); };

const eventOf = (value, index) => {
  check(value !== null && typeof value === "object", `event ${index} must be an object`);
  check(typeof value.type === "string" && value.type.length > 0, `event ${index} needs a type`);
  check(typeof value.actorId === "string" && value.actorId.length > 0, `event ${index} needs an actorId`);
  check(typeof value.at === "string" && !Number.isNaN(new Date(value.at).getTime()), `event ${index} needs a parseable at timestamp`);
  return value;
};
const median = values => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
// Analyze the funnel. Stages: invited → joined → first_work.
export function funnelAnalysis(events) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const agents = new Map();
  events.forEach((event, index) => {
    const { type, actorId, at } = eventOf(event, index);
    if (!agents.has(actorId)) agents.set(actorId, { invitedAt: null, joinedAt: null, firstWorkAt: null });
    const agent = agents.get(actorId);
    if (type === "member.invited" && !agent.invitedAt) agent.invitedAt = at;
    if ((type === "member.joined" || type === "member.joined_via_invitation") && !agent.joinedAt) agent.joinedAt = at;
    if (WORK_TYPES.includes(type) && !agent.firstWorkAt) agent.firstWorkAt = at;
  });
  const invited = [], joined = [], worked = [];
  const inviteToJoin = [], joinToWork = [];
  for (const [actorId, agent] of agents) {
    if (agent.invitedAt) {
      invited.push(actorId);
      if (agent.joinedAt && agent.joinedAt >= agent.invitedAt) {
        joined.push(actorId);
        inviteToJoin.push(new Date(agent.joinedAt) - new Date(agent.invitedAt));
      }
    } else if (agent.joinedAt) {
      joined.push(actorId); // joined without a recorded invite
    }
    if (agent.firstWorkAt && agent.joinedAt && agent.firstWorkAt >= agent.joinedAt) {
      worked.push(actorId);
      joinToWork.push(new Date(agent.firstWorkAt) - new Date(agent.joinedAt));
    }
  }
  const rate = (part, whole) => whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
  return Object.freeze({
    invited: invited.length, joined: joined.length, firstWork: worked.length,
    inviteToJoinRate: rate(joined.filter(id => invited.includes(id)).length, invited.length),
    joinToWorkRate: rate(worked.length, joined.length),
    medianInviteToJoinMs: median(inviteToJoin),
    medianJoinToWorkMs: median(joinToWork),
    agents: Object.freeze(Object.fromEntries([...agents.entries()].map(([actorId, agent]) =>
      [actorId, Object.freeze({ ...agent })]))),
  });
}
export { FunnelError, WORK_TYPES };
