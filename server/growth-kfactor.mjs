// K-factor / referral tracking (G010). A pure viral-coefficient calculator
// over a supplied list of room events: for each inviter it counts invites
// sent and invites that converted to joins, then reports the K-factor
// (joined invites per active agent), the invite conversion rate, and the
// median viral cycle time (invite → join latency). Invite attribution comes
// from member.invited events carrying an invitedBy field. The caller supplies
// the events — no store reads. Pure, dependency-free, deterministic; frozen
// outputs. Referral UI is a later slice.
class KFactorError extends Error { constructor(code, message) { super(message); this.name = "KFactorError"; this.code = code; } }
const fail = (code, message) => { throw new KFactorError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_kfactor_input", message); };

const timeOf = (value, label) => {
  const time = new Date(value).getTime();
  check(!Number.isNaN(time), `${label} must be a parseable timestamp`);
  return time;
};
const eventOf = (value, index) => {
  check(value !== null && typeof value === "object", `event ${index} must be an object`);
  check(typeof value.type === "string" && value.type.length > 0, `event ${index} needs a type`);
  check(typeof value.actorId === "string" && value.actorId.length > 0, `event ${index} needs an actorId`);
  return value;
};
const median = values => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
// Compute the K-factor. member.invited events may carry invitedBy: the
// inviter's actorId. Joins reference the invitee's actorId.
export function kFactor(events) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const invites = new Map(); // invitee -> { invitedBy, invitedAt }
  const joins = new Map();   // invitee -> joinedAt
  const active = new Set();
  events.forEach((event, index) => {
    const { type, actorId } = eventOf(event, index);
    if (event.at !== undefined && event.at !== null) timeOf(event.at, `event ${index} at`);
    active.add(actorId);
    if (type === "member.invited") {
      check(typeof event.invitedBy === "string" && event.invitedBy.length > 0, `event ${index} member.invited needs an invitedBy actor`);
      if (!invites.has(actorId)) invites.set(actorId, { invitedBy: event.invitedBy, invitedAt: event.at });
    }
    if ((type === "member.joined" || type === "member.joined_via_invitation") && !joins.has(actorId)) {
      joins.set(actorId, event.at);
    }
  });
  const inviters = new Map(); // inviter -> { sent, converted, cycleMs: [] }
  for (const [invitee, invite] of invites) {
    if (!inviters.has(invite.invitedBy)) inviters.set(invite.invitedBy, { sent: 0, converted: 0, cycleMs: [] });
    const entry = inviters.get(invite.invitedBy);
    entry.sent += 1;
    if (joins.has(invitee)) {
      entry.converted += 1;
      entry.cycleMs.push(timeOf(joins.get(invitee), "join at") - timeOf(invite.invitedAt, "invite at"));
    }
  }
  let sent = 0, converted = 0;
  const perInviter = [...inviters.entries()].map(([inviter, entry]) => {
    sent += entry.sent; converted += entry.converted;
    return Object.freeze({ inviter, sent: entry.sent, converted: entry.converted,
      conversionRate: entry.sent === 0 ? null : Math.round((entry.converted / entry.sent) * 1000) / 10,
      medianCycleMs: median(entry.cycleMs) });
  }).sort((a, b) => b.converted - a.converted || (a.inviter < b.inviter ? -1 : 1));
  return Object.freeze({
    kFactor: active.size === 0 ? null : Math.round((converted / active.size) * 1000) / 1000,
    inviteConversionRate: sent === 0 ? null : Math.round((converted / sent) * 1000) / 10,
    invitesSent: sent, invitesConverted: converted, activeAgents: active.size,
    medianViralCycleMs: median(perInviter.flatMap(entry => {
      const found = inviters.get(entry.inviter);
      return found ? found.cycleMs : [];
    })),
    perInviter: Object.freeze(perInviter),
  });
}
export { KFactorError };
