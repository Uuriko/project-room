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

function uniqueTarget(candidates, senderMemberId) {
  if (!candidates.length) return null;
  const rank = Math.min(...candidates.map(candidate => candidate.rank));
  const ids = new Set(candidates.filter(candidate => candidate.rank === rank).map(candidate => candidate.memberId));
  return ids.size === 1 && !ids.has(senderMemberId) ? [...ids][0] : null;
}

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
    const target = uniqueTarget(matches, senderMemberId);
    if (target && !found.includes(target)) found.push(target);
  }
  return found;
}
