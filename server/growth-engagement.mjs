// Per-room engagement scoring (G007). A pure engagement score over a
// supplied list of room events: each event contributes a type weight decayed
// by recency (half-life), and the total is scaled by participant breadth so
// a room with many contributors outscores a one-agent monologue. Scores are
// 0..100 and deterministic when `now` is supplied. The caller supplies the
// events — no store reads. Pure, dependency-free; frozen outputs. Dashboard
// rendering is a later slice.
const TYPE_WEIGHTS = Object.freeze({
  "room.post": 3, "room.read-thread": 1, "room.search": 1,
  "inbox.triage": 2, "work.claim": 4, "work.update": 3,
  "member.joined": 5, "member.added": 5,
});
const DEFAULT_WEIGHT = 1;
class EngagementError extends Error { constructor(code, message) { super(message); this.name = "EngagementError"; this.code = code; } }
const fail = (code, message) => { throw new EngagementError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_engagement_input", message); };

const eventOf = (value, index) => {
  check(value !== null && typeof value === "object", `event ${index} must be an object`);
  check(typeof value.type === "string" && value.type.length > 0, `event ${index} needs a type`);
  check(typeof value.actorId === "string" && value.actorId.length > 0, `event ${index} needs an actorId`);
  check(typeof value.at === "string" && !Number.isNaN(new Date(value.at).getTime()), `event ${index} needs a parseable at timestamp`);
  return value;
};
const nowOf = value => {
  if (value === undefined || value === null) return Date.now();
  const time = new Date(value).getTime();
  check(!Number.isNaN(time), "now must be a parseable timestamp");
  return time;
};
// Score a room's engagement 0..100. halfLifeDays controls recency decay.
export function engagementScore(events, { now, halfLifeDays } = {}) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const at = nowOf(now);
  const halfLife = halfLifeDays ?? 7;
  check(typeof halfLife === "number" && halfLife > 0 && halfLife <= 365, "halfLifeDays must be 0..365");
  if (events.length === 0) return Object.freeze({ score: 0, eventCount: 0, participants: 0, breakdown: Object.freeze({}) });
  const participants = new Set(), breakdown = {};
  let weighted = 0;
  events.forEach((event, index) => {
    const { type, actorId, at: eventAt } = eventOf(event, index);
    const ageDays = Math.max(0, (at - new Date(eventAt).getTime()) / 86400000);
    const decay = 2 ** (-ageDays / halfLife);
    const weight = TYPE_WEIGHTS[type] ?? DEFAULT_WEIGHT;
    weighted += weight * decay;
    participants.add(actorId);
    breakdown[type] = (breakdown[type] ?? 0) + 1;
  });
  // Breadth multiplier: 1 participant → 0.6, 2 → 0.8, 3+ → 1.0.
  const breadth = participants.size >= 3 ? 1 : participants.size === 2 ? 0.8 : 0.6;
  const score = Math.min(100, Math.round(weighted * breadth * 2));
  return Object.freeze({ score, eventCount: events.length, participants: participants.size,
    breakdown: Object.freeze({ ...breakdown }) });
}
// Rank rooms by engagement.
export function rankRooms(roomEvents, options = {}) {
  check(roomEvents !== null && typeof roomEvents === "object" && !Array.isArray(roomEvents), "roomEvents must be an object keyed by room id");
  const ranked = Object.entries(roomEvents).map(([roomId, events]) =>
    Object.freeze({ roomId, ...engagementScore(events, options) }));
  ranked.sort((a, b) => b.score - a.score || (a.roomId < b.roomId ? -1 : 1));
  return Object.freeze(ranked);
}
export { EngagementError, TYPE_WEIGHTS };
