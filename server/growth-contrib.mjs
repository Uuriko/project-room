// Per-agent contribution stats (G006). A pure stats builder over a supplied
// list of room events: per-agent event counts broken down by type, plus
// first/last seen and active days. The caller supplies the events — no store
// reads. Pure, dependency-free, deterministic; frozen outputs. Rendering
// (leaderboard UI) is a later slice.
class ContribError extends Error { constructor(code, message) { super(message); this.name = "ContribError"; this.code = code; } }
const fail = (code, message) => { throw new ContribError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_contrib_input", message); };

const eventOf = (value, index) => {
  check(value !== null && typeof value === "object", `event ${index} must be an object`);
  check(typeof value.type === "string" && value.type.length > 0, `event ${index} needs a type`);
  check(typeof value.actorId === "string" && value.actorId.length > 0, `event ${index} needs an actorId`);
  check(typeof value.at === "string" && value.at.length > 0, `event ${index} needs an at timestamp`);
  return value;
};
const dayOf = at => {
  const day = new Date(at);
  check(!Number.isNaN(day.getTime()), `unparseable timestamp "${at}"`);
  return day.toISOString().slice(0, 10);
};
// Build per-agent contribution stats from events.
export function contributionStats(events) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const agents = new Map();
  events.forEach((event, index) => {
    const { type, actorId, at } = eventOf(event, index);
    if (!agents.has(actorId)) agents.set(actorId, { byType: new Map(), days: new Set(), firstSeen: at, lastSeen: at });
    const agent = agents.get(actorId);
    agent.byType.set(type, (agent.byType.get(type) ?? 0) + 1);
    agent.days.add(dayOf(at));
    if (at < agent.firstSeen) agent.firstSeen = at;
    if (at > agent.lastSeen) agent.lastSeen = at;
  });
  const stats = [...agents.entries()].map(([actorId, agent]) => {
    const byType = Object.fromEntries([...agent.byType.entries()].sort());
    const total = [...agent.byType.values()].reduce((sum, count) => sum + count, 0);
    return Object.freeze({ actorId, total, byType: Object.freeze(byType),
      activeDays: agent.days.size, firstSeen: agent.firstSeen, lastSeen: agent.lastSeen });
  }).sort((a, b) => b.total - a.total || (a.actorId < b.actorId ? -1 : 1));
  return Object.freeze(stats);
}
// Leaderboard: top N agents with rank.
export function leaderboard(events, { top } = {}) {
  const take = top ?? 10;
  check(Number.isInteger(take) && take >= 1 && take <= 500, "top must be an integer 1..500");
  return Object.freeze(contributionStats(events).slice(0, take)
    .map((entry, index) => Object.freeze({ ...entry, rank: index + 1 })));
}
export { ContribError };
