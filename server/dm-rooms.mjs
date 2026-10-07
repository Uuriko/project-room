// DM membership model: pair + group direct messages.
//
// Pair DMs travel as message.posted events with data.toMemberId; group DMs
// (3-8 members) travel the same path with data.toMemberIds. This module is
// the membership model both share: addressing extraction for the read path
// and strict membership validation for the write path.
//
// Consent gating stays in server/dm-consents.mjs (directional, open by
// default — requireDmAllowed is called once per group member, the same call
// pair DMs make). Visibility scoping reuses the pair-DM predicates in
// server/store.mjs and server/http.mjs through dmTargetIds.
//
// The module is pure and dependency-free: the store must avoid an import
// cycle with dm-consents, and node:test covers this without a database.
// Message views carry the addressing top-level (toMemberId / toMemberIds);
// events carry it under data — dmTargetIds reads both shapes.
class DmError extends Error {
  constructor(code, message) { super(message); this.name = "DmError"; this.code = code; }
}

// A group DM addresses 3-8 members. Pairs stay on toMemberId: a 2-address
// toMemberIds would be a second representation of the same conversation.
export const DM_GROUP_MIN_MEMBERS = 3;
export const DM_GROUP_MAX_MEMBERS = 8;

// Addressed member ids for a DM event or message view: [] for a public
// message, [toMemberId] for a pair DM, [...toMemberIds] for a group DM.
// Lenient by design — the read path must never throw on stored data; the
// write path validates strictly with assertGroupDmMembers.
export function dmTargetIds(data) {
  if (!data || typeof data !== "object") return Object.freeze([]);
  const raw = Array.isArray(data.toMemberIds)
    ? data.toMemberIds
    : (typeof data.toMemberId === "string" && data.toMemberId ? [data.toMemberId] : []);
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return Object.freeze(out);
}

// Strict write-path validation for data.toMemberIds. Returns the frozen
// member list or throws DmError("invalid_dm"). The sender is always an
// implicit participant, so listing them is refused rather than silently
// dropped — a silent drop would shrink the group below the caller's intent.
export function assertGroupDmMembers(memberIds, senderId) {
  const fail = message => { throw new DmError("invalid_dm", message); };
  if (!Array.isArray(memberIds)) fail("toMemberIds must be an array of member ids");
  if (memberIds.length < DM_GROUP_MIN_MEMBERS || memberIds.length > DM_GROUP_MAX_MEMBERS) {
    fail(`toMemberIds must address ${DM_GROUP_MIN_MEMBERS}-${DM_GROUP_MAX_MEMBERS} members`);
  }
  const seen = new Set();
  for (const id of memberIds) {
    if (typeof id !== "string" || !id) fail("toMemberIds must contain only non-empty member id strings");
    if (id === senderId) fail("the sender is always a group DM participant; do not list them in toMemberIds");
    if (seen.has(id)) fail("toMemberIds must not contain duplicate members");
    seen.add(id);
  }
  return Object.freeze([...memberIds]);
}

export { DmError };
