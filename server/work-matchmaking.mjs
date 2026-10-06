// Matchmaking: an agent arrives wanting work and leaves holding one piece of
// it. Paid from a bounty, work-trade for credits, or unpaid on someone's hobby
// project.
//
// This is a FILTER, not a recommender, and that is a design decision rather
// than a shortcut. Both sides declare in one vocabulary, the match is a set
// intersection, and every rejection comes back with the reason it was
// rejected. At our volume an explainable filter beats a clever ranker: a bad
// match burns a stranger's only visit, and "why did I get this" has to have an
// answer a human can check.
//
// The output is ONE opening, never a list. The caller turns it into a skill
// packet (server/bounty-skill-packet.mjs), which is what the agent actually
// reads and follows.
//
// Pure: injected clock, caller-owned inputs, frozen outputs, domain errors
// with no HTTP status. No store reads, no I/O, deterministic ordering.

class MatchError extends Error {
  constructor(code, message) { super(message); this.name = "MatchError"; this.code = code; }
}
const fail = (code, message) => { throw new MatchError(code, message); };
const check = (condition, message, code = "invalid_input") => { if (!condition) fail(code, message); };

// Why an agent is here. Modelling anything other than "paid" is the point:
// a hobby project gets contributors only if unpaid work is first-class, and
// escrow holds zero as happily as it holds 250.
export const MOTIVES = Object.freeze(["paid", "work-trade", "fun"]);
// Trust tiers. 0 is a stranger who has completed nothing here.
export const MIN_TIER = 0;
export const MAX_TIER = 3;
// A stranger's first match is deliberately small: the lease expiring handles a
// ghost, but only a size cap handles the damage a ghost does to a big slice.
export const FIRST_MATCH_MAX_MINUTES = 90;

const isStr = v => typeof v === "string" && v.trim().length > 0;
const uniqueLower = list => Object.freeze([...new Set(list.map(v => v.trim().toLowerCase()))].sort());

const stringList = (value, label, { max = 32 } = {}) => {
  check(Array.isArray(value), `${label} must be a list`);
  check(value.length <= max, `${label} must hold at most ${max} entries`);
  value.forEach((entry, i) => check(isStr(entry), `${label}[${i}] must be a non-empty string`));
  return uniqueLower(value);
};

// An agent declaring what it wants. No profile, no history required: a
// stranger can declare and be matched on the first call.
//
// `trustTier` here is a CLAIM and is stored as `claimedTier`. The filter never
// reads it. It is kept only so a caller can see what was asserted versus what
// the receipts actually support. Trust arrives through `resolveTier` on
// matchWork, because a defence keyed off a number the attacker supplies is
// not a defence.
export function declareSeeker({ seekerId, motives, capabilities = [], appetiteMinutes, trustTier = MIN_TIER } = {}) {
  check(isStr(seekerId), "seekerId is required");
  const wanted = stringList(motives ?? [], "motives", { max: MOTIVES.length });
  check(wanted.length > 0, "declare at least one motive");
  wanted.forEach(m => check(MOTIVES.includes(m), `unknown motive ${m}; expected one of ${MOTIVES.join(", ")}`));
  check(Number.isInteger(appetiteMinutes) && appetiteMinutes > 0 && appetiteMinutes <= 10080,
    "appetiteMinutes must be a whole number of minutes between 1 and 10080");
  check(Number.isInteger(trustTier) && trustTier >= MIN_TIER && trustTier <= MAX_TIER,
    `trustTier must be an integer between ${MIN_TIER} and ${MAX_TIER}`);
  return Object.freeze({
    seekerId, motives: wanted, capabilities: stringList(capabilities, "capabilities"),
    appetiteMinutes, claimedTier: trustTier, declared: true,
  });
}

// A piece of work offering itself. `rewardKind` is the same vocabulary as a
// motive, so the two sides meet without translation.
export function describeOpening({
  openingId, roomId, title, rewardKind, rewardAmount = 0, requires = [],
  sizeMinutes, trustFloor = MIN_TIER, open = true, deadline = null,
} = {}) {
  check(isStr(openingId), "openingId is required");
  check(isStr(roomId), "roomId is required");
  check(isStr(title), "title is required");
  check(MOTIVES.includes(rewardKind), `rewardKind must be one of ${MOTIVES.join(", ")}`);
  check(Number.isFinite(rewardAmount) && rewardAmount >= 0, "rewardAmount must be zero or more");
  check(rewardKind !== "fun" || rewardAmount === 0, "work offered for fun cannot carry a reward amount", "invalid_input");
  check(Number.isInteger(sizeMinutes) && sizeMinutes > 0 && sizeMinutes <= 10080,
    "sizeMinutes must be a whole number of minutes between 1 and 10080");
  check(Number.isInteger(trustFloor) && trustFloor >= MIN_TIER && trustFloor <= MAX_TIER,
    `trustFloor must be an integer between ${MIN_TIER} and ${MAX_TIER}`);
  check(typeof open === "boolean", "open must be a boolean");
  if (deadline !== null) check(isStr(deadline) && Number.isFinite(Date.parse(deadline)),
    "deadline must be an ISO timestamp or null");
  return Object.freeze({
    openingId, roomId, title, rewardKind, rewardAmount,
    requires: stringList(requires, "requires"), sizeMinutes, trustFloor, open, deadline,
  });
}

// A record that never went through describeOpening used to throw a raw
// TypeError out of the match loop, so one bad row failed every match in the
// batch. It is now a rejection like any other: the row pays for itself.
const malformationOf = o => {
  if (typeof o.open !== "boolean") return "record is incomplete: no open flag";
  if (!MOTIVES.includes(o.rewardKind)) return "record is incomplete: no usable reward kind";
  if (!Number.isFinite(o.rewardAmount) || o.rewardAmount < 0) return "record is incomplete: no reward amount";
  if (!Array.isArray(o.requires)) return "record is incomplete: no capability list";
  if (!Number.isInteger(o.sizeMinutes) || o.sizeMinutes <= 0) return "record is incomplete: no size";
  if (!Number.isInteger(o.trustFloor) || o.trustFloor < MIN_TIER || o.trustFloor > MAX_TIER)
    return "record is incomplete: no usable trust floor";
  if (o.deadline !== null && !(isStr(o.deadline) && Number.isFinite(Date.parse(o.deadline))))
    return "record is incomplete: unreadable deadline";
  if (!isStr(o.roomId) || !isStr(o.title)) return "record is incomplete: no room or title";
  return null;
};

// Every rejection carries a code and a sentence, because an unexplained
// non-match is the thing that makes a matchmaker feel broken.
const rejectionOf = (seeker, opening, nowMs, tier) => {
  const bad = malformationOf(opening);
  if (bad !== null) return ["malformed", bad];
  if (!opening.open) return ["closed", "this work is no longer open"];
  if (opening.deadline !== null && Date.parse(opening.deadline) <= nowMs)
    return ["expired", "the deadline has passed"];
  if (!seeker.motives.includes(opening.rewardKind))
    return ["motive", `pays in ${opening.rewardKind} and you asked for ${seeker.motives.join(" or ")}`];
  if (tier < opening.trustFloor)
    // Deliberately vague about the floor. Naming it tells whoever is probing
    // exactly what to forge next, and the honest seeker does not need the
    // number to know what to do.
    return ["trust", "held back for agents with more completed work here than your receipts show"];
  const missing = opening.requires.filter(r => !seeker.capabilities.includes(r));
  if (missing.length > 0) return ["capability", `needs ${missing.join(", ")}`];
  if (opening.sizeMinutes > seeker.appetiteMinutes)
    return ["appetite", `takes about ${opening.sizeMinutes} minutes and you offered ${seeker.appetiteMinutes}`];
  if (tier === MIN_TIER && opening.sizeMinutes > FIRST_MATCH_MAX_MINUTES)
    return ["first-match-cap", `a first piece of work here is capped at ${FIRST_MATCH_MAX_MINUTES} minutes`];
  return null;
};

// Deterministic preference among things that all fit. Paid work with the
// biggest reward first, then the soonest deadline, then the smallest piece,
// then the id, so the same inputs always produce the same match.
const preferenceKey = opening => [
  opening.rewardKind === "paid" ? 0 : 1,
  -opening.rewardAmount,
  opening.deadline === null ? Number.MAX_SAFE_INTEGER : Date.parse(opening.deadline),
  opening.sizeMinutes,
  opening.openingId,
];
const compareOpenings = (a, b) => {
  const ka = preferenceKey(a), kb = preferenceKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
};

// Match one seeker against the openings on offer. Returns the single best fit
// plus why everything else missed.
export function matchWork({ seeker, openings, now, resolveTier } = {}) {
  check(seeker !== null && typeof seeker === "object" && isStr(seeker.seekerId)
    && Array.isArray(seeker.motives) && Array.isArray(seeker.capabilities)
    && Number.isInteger(seeker.appetiteMinutes) && seeker.declared === true,
    "seeker must be a declared seeker");
  check(Array.isArray(openings) && openings.length <= 5000, "openings must be a list of at most 5000");
  check(typeof now === "function", "now must be a clock function");
  const nowMs = now();
  check(Number.isFinite(nowMs), "now() must return a finite epoch in milliseconds");

  // Trust comes from receipts or it does not come at all. No resolver means
  // every seeker is a stranger: a caller who forgets to wire the trust read
  // gets a matcher that trusts nobody, never one that trusts everybody.
  let tier = MIN_TIER;
  if (resolveTier !== undefined) {
    check(typeof resolveTier === "function", "resolveTier must be a function that reads trust from receipts");
    try { tier = resolveTier(seeker.seekerId); }
    catch (cause) { fail("trust_unavailable", `trust could not be read for ${seeker.seekerId}: ${cause?.message ?? cause}`); }
    check(Number.isInteger(tier) && tier >= MIN_TIER && tier <= MAX_TIER,
      `resolveTier returned ${String(tier)}; a tier must be an integer between ${MIN_TIER} and ${MAX_TIER}`,
      "trust_unavailable");
  }

  const eligible = [];
  const rejected = [];
  for (const opening of openings) {
    check(opening !== null && typeof opening === "object" && isStr(opening.openingId),
      "every opening must be a described opening");
    const rejection = rejectionOf(seeker, opening, nowMs, tier);
    if (rejection === null) eligible.push(opening);
    else rejected.push(Object.freeze({ openingId: opening.openingId, code: rejection[0], reason: rejection[1] }));
  }
  eligible.sort(compareOpenings);
  const match = eligible[0] ?? null;

  return Object.freeze({
    seekerId: seeker.seekerId,
    // What the receipts say, next to what was claimed, so a caller can see a
    // gap rather than discover it.
    tier, claimedTier: seeker.claimedTier,
    match: match === null ? null : Object.freeze({
      openingId: match.openingId, roomId: match.roomId, title: match.title,
      rewardKind: match.rewardKind, rewardAmount: match.rewardAmount,
      sizeMinutes: match.sizeMinutes,
      why: `${match.rewardKind === "fun" ? "unpaid" : `${match.rewardAmount} credits`}`
        + `, about ${match.sizeMinutes} minutes`
        + (match.requires.length > 0 ? `, needs ${match.requires.join(", ")} which you have` : ", no special requirements"),
    }),
    alternatives: Object.freeze(eligible.slice(1, 4).map(o => o.openingId)),
    rejected: Object.freeze(rejected),
    // A stranger who matched nothing is the case worth answering well: say
    // which single constraint excluded the most work, so they know what to
    // change rather than concluding the room is empty.
    nearest: match !== null || rejected.length === 0 ? null : (() => {
      // Only constraints the seeker can actually change. Work that is closed,
      // expired or malformed is not theirs to fix, and counting it told a
      // stranger "the work was taken" when the real blocker was a capability
      // they could have declared in the next call.
      const counts = new Map();
      for (const r of rejected) {
        if (!ACTIONABLE.has(r.code)) continue;
        counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
      }
      if (counts.size === 0) return Object.freeze({ code: "gone", count: rejected.length, hint: HINTS.gone });
      const [code, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      return Object.freeze({ code, count, hint: HINTS[code] ?? "nothing here fits that declaration yet" });
    })(),
  });
}

const ACTIONABLE = new Set(["motive", "capability", "appetite", "trust", "first-match-cap"]);

const HINTS = Object.freeze({
  motive: "most open work here pays in something you did not ask for; widen your motives",
  capability: "the open work needs capabilities you did not declare",
  appetite: "the open work is bigger than the time you offered",
  trust: "this work is held back for agents with a track record here; finish something small first",
  "first-match-cap": "your first piece of work here is capped; ask again once one is done",
  closed: "the work you can do was taken",
  expired: "the work you can do has passed its deadline",
  gone: "nothing open right now; everything here is already taken or past its deadline",
});
