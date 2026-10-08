import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

// #658: mention lifecycle tracking — pure state machine, mention schema,
// and member-resolution helper. Dependency-free and unit-testable without
// a database. The store (server/store.mjs) owns persistence; this module
// owns the transition rules and timeout arithmetic.
//
// Lifecycle: delivered -> acknowledged -> responded; delivered|acknowledged
// -> timed_out. Terminal: responded, timed_out. A post by the mentioned
// member transitions straight to responded (a reply is stronger than a
// read). Timeouts are evaluated lazily on read — no background job in v1.

export const MENTION_STATES = Object.freeze(["delivered", "acknowledged", "responded", "timed_out"]);

// Default mention timeout: 30 minutes. A room may override it via
// room_mention_settings (owner-configurable); absent rows read as default.
export const MENTION_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;
export const MENTION_TIMEOUT_MS_MIN = 60 * 1000;
export const MENTION_TIMEOUT_MS_MAX = 24 * 60 * 60 * 1000;

const TRANSITIONS = Object.freeze({
  delivered: Object.freeze(["acknowledged", "responded", "timed_out"]),
  acknowledged: Object.freeze(["responded", "timed_out"]),
  responded: Object.freeze([]),
  timed_out: Object.freeze([]),
});

export function isMentionState(value) {
  return typeof value === "string" && MENTION_STATES.includes(value);
}

export function isTerminalMentionState(state) {
  if (!isMentionState(state)) throw new Error(`unknown mention state: ${state}`);
  return state === "responded" || state === "timed_out";
}

export function canTransitionMention(from, to) {
  if (!isMentionState(from) || !isMentionState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

// Throws on an illegal transition; terminal states never transition.
export function assertTransitionMention(from, to) {
  if (!isMentionState(from)) throw new Error(`unknown mention state: ${from}`);
  if (!isMentionState(to)) throw new Error(`unknown mention state: ${to}`);
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`illegal mention transition: ${from} -> ${to}`);
  }
}

// Effective state of a mention row at `nowMs`: a non-terminal row whose
// timeout has passed reads as timed_out. Pure — persistence of the flip
// is the store's job (lazy, on read).
export function effectiveMentionState({ state, timeoutAt }, nowMs) {
  if (!isMentionState(state)) throw new Error(`unknown mention state: ${state}`);
  if (Number.isFinite(timeoutAt) && !isTerminalMentionState(state) && timeoutAt <= nowMs) return "timed_out";
  return state;
}

// Exact ids take precedence over names. Display-name prefixes end at a
// whitespace boundary ("Claude" in "Claude (Cowork)", not "Cl"), and only
// resolve when unique across the active roster, including the sender.
function mentionCandidates(members, identityNames) {
  const candidates = [];
  for (const [memberId, member] of Object.entries(members ?? {})) {
    if (!member || member.active === false) continue;
    [memberId, member.displayName, identityNames?.[memberId]].forEach((name, rank) => {
      if (typeof name !== "string" || !name.trim()) return;
      candidates.push({ memberId, lower: name.toLowerCase(), rank });
      if (rank === 1) {
        for (const match of name.matchAll(/\s+/g)) {
          if (match.index > 0) candidates.push({ memberId, lower: name.slice(0, match.index).toLowerCase(), rank: 3 });
        }
      }
    });
  }
  return candidates;
}

function uniqueTargets(candidates, senderMemberId) {
  if (!candidates.length) return [];
  const rank = Math.min(...candidates.map(c => c.rank));
  const tier = candidates.filter(c => c.rank === rank);
  // The sender in the best tier (a self-mention, or a tie with the sender)
  // resolves to nobody, exactly as before G16b.
  if (tier.some(c => c.memberId === senderMemberId)) return [];
  const ids = new Set(tier.map(c => c.memberId));
  if (ids.size === 1) return [[...ids][0]];
  // AUX-21 / G16b: legacy duplicate display names in the room (e.g. multiple Instinct members).
  // When an exact display name match (rank 1) has multiple active non-sender candidates,
  // notify all matching candidates so no active agent misses the wake.
  if (ids.size > 1 && rank === 1) {
    return [...ids];
  }
  return [];
}

function uniqueTarget(candidates, senderMemberId) {
  const targets = uniqueTargets(candidates, senderMemberId);
  return targets.length ? targets[0] : null;
}

// Two-trigger discipline (lane B8): interrupt suppression/re-arm driven off
// the mention lifecycle transitions. `state` is the mention's current
// lifecycle state; the caller supplies whether a second interrupt for the
// same request falls inside the 30-minute dedupe window (collapses into the
// first) and whether a fresh explicit request re-arms a timed-out mention.
// Pure and additive: terminal `responded` never re-fires; `delivered` /
// `acknowledged` fire once per window; only a fresh explicit request after
// `timed_out` re-arms.
export function mentionInterruptGate({ state, explicitReRequest = false, withinDedupeWindow = false } = {}) {
  if (!isMentionState(state)) throw new Error(`unknown mention state: ${state}`);
  if (state === "responded") return Object.freeze({ fire: false, reason: "mention already responded" });
  if (state === "timed_out") {
    return explicitReRequest
      ? Object.freeze({ fire: true, reason: "fresh explicit request after timeout re-arms the interrupt" })
      : Object.freeze({ fire: false, reason: "timed out without a fresh explicit request" });
  }
  return withinDedupeWindow
    ? Object.freeze({ fire: false, reason: "collapsed into the pending interrupt (dedupe window)" })
    : Object.freeze({ fire: true, reason: "first interrupt for this request" });
}

// Resolve an @name to a room member id. `members` is the room projection's
// members map ({ memberId: { displayName, kind, active } });
// `identityNames` maps memberId -> linked agent-identity display name.
// Match order: memberId, then displayName, then identity display name —
// all case-insensitive, first match wins. Skips the sender and inactive
// members; returns null when nothing resolves (never invent a recipient).
export function resolveMentionTarget(members, identityNames, name, senderMemberId) {
  if (typeof name !== "string" || !name) return null;
  return uniqueTarget(mentionCandidates(members, identityNames)
    .filter(candidate => candidate.lower === name.toLowerCase()), senderMemberId);
}

export const mentionStateSchema = `
  CREATE TABLE IF NOT EXISTS mention_states (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    message_event_id TEXT NOT NULL,
    mentioned_member_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('delivered','acknowledged','responded','timed_out')),
    created_at INTEGER NOT NULL,
    timeout_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY(room_id,message_event_id,mentioned_member_id)
  );
  CREATE INDEX IF NOT EXISTS mention_states_member ON mention_states(room_id,mentioned_member_id,state);
  CREATE INDEX IF NOT EXISTS mention_states_message ON mention_states(room_id,message_event_id);
  CREATE TABLE IF NOT EXISTS room_mention_settings (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    timeout_ms INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// Member id -> linked agent-identity display name. Mention detection and
// mention delivery must resolve the same names: every @-resolution path
// shares this map, or a mention the tracker records as delivered never wakes
// its agent. Never throws: a database without the identity tables simply has
// no identity aliases.
export function identityNamesForRoom(db, roomId) {
  try {
    const links = db.prepare(
      `SELECT l.member_id AS memberId, i.display_name AS displayName FROM identity_links l
       JOIN agent_identities i ON i.identity_id=l.identity_id
       WHERE l.room_id=? AND i.revoked_at IS NULL`).all(roomId);
    return Object.fromEntries(links.map(row => [row.memberId, row.displayName]));
  } catch {
    return {};
  }
}

// Resolve explicit @mentions using the longest complete label first, then
// exact-id/name precedence and uniqueness. Never fall back from an ambiguous
// longer label to a shorter recipient. Silent @_mentions, email addresses,
// inactive members, and self-mentions do not create delivery targets.
export function resolveMentionTargetsInText(members, identityNames, text, senderMemberId) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MESSAGE_BODY_CHARS) return [];
  const candidates = mentionCandidates(members, identityNames);
  const lowerText = text.toLowerCase(), found = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && /[A-Za-z0-9_.@]/.test(text[at - 1])) continue;
    if (text[at + 1] === "_") continue;
    const nameAt = at + 1;
    let matches = [], longest = 0;
    for (const candidate of candidates) {
      const end = nameAt + candidate.lower.length;
      if (lowerText.slice(nameAt, end) !== candidate.lower) continue;
      if (end < text.length && /[A-Za-z0-9_]/.test(text[end])) continue;
      if (candidate.lower.length > longest) { matches = []; longest = candidate.lower.length; }
      if (candidate.lower.length === longest) matches.push(candidate);
    }
    const targets = uniqueTargets(matches, senderMemberId);
    for (const target of targets) {
      if (!found.includes(target)) found.push(target);
    }
  }
  return found;
}

// COMMS-02: per-handle mention warnings for the poster. An @mention whose
// target is unclear deserves a nudge so the poster can disambiguate. Uses the
// exact longest-label-first scan as resolveMentionTargetsInText:
//   - "ambiguous": the handle matches 2+ distinct active members at the best
//     rank (the P5 two-members-named-Instinct case). Post-G16b an exact
//     display-name duplicate notifies ALL of them, and a prefix tie notifies
//     nobody — either way the target is genuinely ambiguous, so the warning
//     fires and candidates name each member ({memberId, displayName}).
//   - "not_member": the handle matches no active member at all.
// Handles that resolve to exactly one member carry no warning, and a handle
// whose only match is the sender is intentional self-silence, not a warning.
// Silent @_mentions and email addresses are skipped like delivery. Pure and
// frozen; never throws for unparseable input.
export function mentionTargetWarnings(members, identityNames, text, senderMemberId) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MESSAGE_BODY_CHARS) return [];
  const candidates = mentionCandidates(members, identityNames);
  const displayOf = memberId => {
    const name = members?.[memberId]?.displayName;
    return typeof name === "string" && name.trim() ? name : memberId;
  };
  const lowerText = text.toLowerCase(), warnings = [], seen = new Set();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && /[A-Za-z0-9_.@]/.test(text[at - 1])) continue;
    if (text[at + 1] === "_") continue;
    const nameAt = at + 1;
    let matches = [], longest = 0;
    for (const candidate of candidates) {
      const end = nameAt + candidate.lower.length;
      if (lowerText.slice(nameAt, end) !== candidate.lower) continue;
      if (end < text.length && /[A-Za-z0-9_]/.test(text[end])) continue;
      if (candidate.lower.length > longest) { matches = []; longest = candidate.lower.length; }
      if (candidate.lower.length === longest) matches.push(candidate);
    }
    if (longest === 0) {
      // No member label matches here: take the raw handle text for the
      // warning (same handle grammar as the mention parser).
      const rawHandle = /^@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/.exec(text.slice(at))?.[1]?.replace(/[._-]+$/, "") ?? "";
      const key = `not_member:${rawHandle.toLowerCase()}`;
      if (rawHandle && !seen.has(key)) {
        seen.add(key);
        warnings.push(Object.freeze({ handle: rawHandle, reason: "not_member", candidates: Object.freeze([]) }));
      }
      continue;
    }
    const rank = Math.min(...matches.map(match => match.rank));
    const ids = [...new Set(matches.filter(match => match.rank === rank).map(match => match.memberId))];
    if (ids.length === 1 && ids[0] === senderMemberId) continue; // intentional self-silence
    if (ids.length <= 1) continue; // exactly one recipient: delivery is unambiguous
    const handle = text.slice(nameAt, nameAt + longest);
    const key = `ambiguous:${handle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(Object.freeze({ handle, reason: "ambiguous",
      candidates: Object.freeze(ids.map(memberId =>
        Object.freeze({ memberId, displayName: displayOf(memberId) }))) }));
  }
  return Object.freeze(warnings);
}
