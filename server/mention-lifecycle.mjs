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

// Resolve an @name to a room member id. `members` is the room projection's
// members map ({ memberId: { displayName, kind, active } });
// `identityNames` maps memberId -> linked agent-identity display name.
// Match order: memberId, then displayName, then identity display name —
// all case-insensitive, first match wins. Skips the sender and inactive
// members; returns null when nothing resolves (never invent a recipient).
export function resolveMentionTarget(members, identityNames, name, senderMemberId) {
  if (typeof name !== "string" || name.length === 0) return null;
  const lower = name.toLowerCase();
  const entries = Object.entries(members ?? {});
  const eligible = ([memberId, member]) =>
    member && member.active !== false && memberId !== senderMemberId;
  for (const [memberId] of entries) {
    if (!eligible([memberId, members[memberId]])) continue;
    if (memberId.toLowerCase() === lower) return memberId;
  }
  for (const [memberId, member] of entries) {
    if (!eligible([memberId, member])) continue;
    const display = typeof member.displayName === "string" ? member.displayName.toLowerCase() : "";
    if (display !== "" && display === lower) return memberId;
  }
  for (const [memberId, member] of entries) {
    if (!eligible([memberId, member])) continue;
    const identity = typeof identityNames?.[memberId] === "string" ? identityNames[memberId].toLowerCase() : "";
    if (identity !== "" && identity === lower) return memberId;
  }
  return null;
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

// Resolve every @mention in a message body to member ids, matching whole
// display names that contain spaces or punctuation ("@Test producer",
// "@Claude (Cowork)"). The single-token parse could only ever see "@Test",
// so members with multi-word names were never mentioned at all. At each "@"
// (not glued to a preceding word, email or handle) the longest member id,
// display name or linked identity name that matches case-insensitively and
// ends at a word boundary wins; ties keep resolveMentionTarget's order
// (member id, then display name, then identity name). Skips the sender and
// inactive members, never invents a recipient, and returns ids in first
// appearance order without duplicates.
//
// `@_Name` is a silent mention (Zulip): the name is resolved the same way,
// starting after the `_`, but it is omitted here. Wake, push, and mention
// rows all read this list, so a silent mention notifies nobody. The chat
// renderer still paints a name only when it already recognizes the text.
export function resolveMentionTargetsInText(members, identityNames, text, senderMemberId) {
  return collectMentionTargets(members, identityNames, text, senderMemberId, false);
}

// Same resolution as resolveMentionTargetsInText, but only the silent
// `@_Name` hits. For a later renderer; nothing in the wake path reads it.
export function resolveSilentMentionTargetsInText(members, identityNames, text, senderMemberId) {
  return collectMentionTargets(members, identityNames, text, senderMemberId, true);
}

function collectMentionTargets(members, identityNames, text, senderMemberId, silentOnly) {
  if (typeof text !== "string" || text.length === 0 || text.length > 20000) return [];
  const candidates = [];
  for (const [memberId, member] of Object.entries(members ?? {})) {
    if (!member || member.active === false || memberId === senderMemberId) continue;
    const names = [memberId, member.displayName, identityNames?.[memberId]];
    names.forEach((name, rank) => {
      if (typeof name === "string" && name.trim().length > 0) candidates.push({ memberId, lower: name.toLowerCase(), rank });
    });
  }
  if (candidates.length === 0) return [];
  const lowerText = text.toLowerCase(), found = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && /[A-Za-z0-9_.@]/.test(text[at - 1])) continue;
    const silent = text[at + 1] === "_";
    if (silent !== silentOnly) continue;
    const nameAt = at + (silent ? 2 : 1);
    let best = null;
    for (const candidate of candidates) {
      const end = nameAt + candidate.lower.length;
      if (lowerText.slice(nameAt, end) !== candidate.lower) continue;
      if (end < text.length && /[A-Za-z0-9_]/.test(text[end])) continue;
      if (!best || candidate.lower.length > best.lower.length
        || (candidate.lower.length === best.lower.length && candidate.rank < best.rank)) best = candidate;
    }
    if (best && !found.includes(best.memberId)) found.push(best.memberId);
  }
  return found;
}
