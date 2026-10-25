// Join-profile writes. The event is member.profile_set. Claim, wake, and
// needs-me filtering stay out of this module: those files are in open PRs.
import { createHash, randomUUID } from "node:crypto";
import { EVENT_TYPES, applyEvent, event, isRoomArchived, validId } from "../src/events.js";
import {
  assertStoredJoinProfile,
  joinProfilesEqual,
  readDeclaredAgentProfile,
  resolveJoinProfile,
  validateJoinProfile,
} from "../src/agent-join-profile.js";
import { PILOT_LIMITS, ServiceError } from "./store.mjs";
import { evaluateAdmission, jevVelocityWindowMs } from "./jev-admission.mjs";

const rateHash = value => createHash("sha256").update(String(value)).digest("hex");

const JOIN_PROFILE_MESSAGES = Object.freeze({
  join_profile_wake: "Set wake to push, webhook, or pull.",
  join_profile_events: "Set events to mentions-and-own-claims or all.",
  join_profile_max_claims: "Set maxClaims to an integer from 1 to 10.",
  join_profile_roles: "Set roles to a list of coordinator, reviewer, or builder, without duplicates.",
  join_profile_detail: "Set detail to brief or full.",
  join_profile_capabilities: "Set capabilities to at most 20 tags, each 1 to 40 characters, without duplicates.",
  join_profile_forbidden: "Only this member or the room owner can read or change this join profile.",
  join_profile_conflict: "This join already recorded a different profile.",
});

function invalidProfileMessage(problem) {
  if (problem?.reason === "unknown" && typeof problem.field === "string") {
    return `Remove unknown profile field ${problem.field}. Use wake, events, maxClaims, roles, detail, or capabilities.`;
  }
  if (problem?.reason === "empty") return "Send at least one profile field, or omit profile to keep the defaults.";
  if (problem?.reason === "missing" && typeof problem.field === "string") {
    return `Profile is missing ${problem.field}. Send the full join profile.`;
  }
  return "Send a profile object with wake, events, maxClaims, roles, detail, or capabilities. Omit profile to keep the defaults.";
}

function joinProfileCopy(problem) {
  const code = JOIN_PROFILE_MESSAGES[problem?.code] ? problem.code : "join_profile_invalid";
  const message = problem?.message || (code === "join_profile_invalid" ? invalidProfileMessage(problem) : JOIN_PROFILE_MESSAGES[code]);
  const next = problem?.next || (code === "join_profile_forbidden"
    ? "Retry as this member or the room owner."
    : code === "join_profile_conflict"
      ? "Read the stored profile and resend the same one, or omit profile."
      : message);
  return { code, message, next };
}

function withNext(error, next) {
  error.detail = { next: [{ command: next }] };
  throw error;
}

export function throwJoinProfile(problem) {
  const { code, message, next } = joinProfileCopy(problem);
  switch (code) {
    case "join_profile_wake": withNext(new ServiceError(422, "join_profile_wake", message), next); break;
    case "join_profile_events": withNext(new ServiceError(422, "join_profile_events", message), next); break;
    case "join_profile_max_claims": withNext(new ServiceError(422, "join_profile_max_claims", message), next); break;
    case "join_profile_roles": withNext(new ServiceError(422, "join_profile_roles", message), next); break;
    case "join_profile_detail": withNext(new ServiceError(422, "join_profile_detail", message), next); break;
    case "join_profile_capabilities": withNext(new ServiceError(422, "join_profile_capabilities", message), next); break;
    case "join_profile_forbidden": withNext(new ServiceError(403, "join_profile_forbidden", message), next); break;
    case "join_profile_conflict": withNext(new ServiceError(409, "join_profile_conflict", message), next); break;
    default: withNext(new ServiceError(422, "join_profile_invalid", message), next);
  }
}

export function checkedJoinProfile(value, options) {
  const checked = validateJoinProfile(value, options);
  if (!checked.ok) throwJoinProfile(checked);
  return checked.profile;
}

export function profileBody(roomId, memberId, member, extra = {}) {
  const profile = readDeclaredAgentProfile(member);
  const { declared, ...fields } = profile;
  return { roomId, memberId, profile: fields, declared, ...extra };
}

export function appendMemberProfile(store, roomId, { actorId, memberId, profile, atMs = null }) {
  const room = store.room(roomId);
  if (isRoomArchived(room.state)) throw new ServiceError(409, "room_archived", "This room is archived");
  if (room.sequence >= PILOT_LIMITS.eventsPerRoom) {
    throw new ServiceError(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
  }
  const stored = assertStoredJoinProfile(profile);
  const stamp = Number.isFinite(atMs) ? atMs : (typeof store.now === "function" ? store.now() : Date.now());
  const incoming = event({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    type: EVENT_TYPES.MEMBER_PROFILE_SET,
    actorId,
    roomId,
    at: new Date(stamp).toISOString(),
    data: { memberId, profile: stored },
  });
  let state;
  try { state = applyEvent(room.state, incoming); }
  catch {
    throw new ServiceError(422, "join_profile_invalid", "Send a profile object with wake, events, maxClaims, roles, detail, or capabilities. Omit profile to keep the defaults.");
  }
  const sequence = room.sequence + 1;
  const compact = { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
  const projection = store.storedProjection(roomId, compact);
  if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) {
    throw new ServiceError(409, "pilot_limit", "Room projection limit reached; no data was changed. Ask the room owner to have older messages archived to free space.");
  }
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, projection, roomId);
  try {
    if (store.agentPlugin) store.agentPlugin.fanoutRoomEvent({ roomId, event: incoming });
  } catch (error) {
    console.error("join profile fan-out failed:", error?.message ?? error);
  }
  return { sequence, event: incoming };
}

function recordJoinProfile(store, result, partial) {
  const roomId = result?.roomId;
  const memberId = result?.memberId;
  if (typeof roomId !== "string" || typeof memberId !== "string") return result;
  const member = store.room(roomId).state.members?.[memberId];
  if (!member || member.kind !== "agent") {
    throwJoinProfile({
      code: "join_profile_invalid",
      message: "Join profiles are for agent members. Omit profile.",
      next: "Omit profile. Join profiles are for agent members.",
    });
  }
  const current = readDeclaredAgentProfile(member);
  const resolved = resolveJoinProfile(current, partial);
  if (result.duplicate === true) {
    if (joinProfilesEqual(current, resolved)) return result;
    throwJoinProfile({
      code: "join_profile_conflict",
      message: "This join already recorded a different profile.",
      next: "Read the stored profile and resend the same one, or omit profile.",
    });
  }
  appendMemberProfile(store, roomId, { actorId: memberId, memberId, profile: resolved });
  return result;
}

export function redeemInviteWithProfile(store, code, options, profile) {
  const partial = profile === undefined ? null : checkedJoinProfile(profile, { partial: true });
  return store.transaction(() => {
    const result = store.invites.redeem(code, options);
    if (partial) recordJoinProfile(store, result, partial);
    return result;
  });
}

export function joinLinkWithProfile(store, secret, linkToken, displayName, profile) {
  const partial = profile === undefined ? null : checkedJoinProfile(profile, { partial: true });
  return store.transaction(() => {
    const result = store.shareLinks.joinAgent(secret, linkToken, displayName);
    if (partial) recordJoinProfile(store, result, partial);
    return result;
  });
}

export function setMemberJoinProfile(store, roomId, { actorId, memberId, partial }) {
  const room = store.room(roomId);
  const member = room.state.members?.[memberId];
  if (!member || member.kind !== "agent") {
    throwJoinProfile({
      code: "join_profile_invalid",
      message: "Join profiles are for agent members.",
      next: "Read the member roster. Join profiles belong to agent members.",
    });
  }
  const current = readDeclaredAgentProfile(member);
  const resolved = resolveJoinProfile(current, partial);
  if (joinProfilesEqual(current, resolved)) return { unchanged: true, member };
  appendMemberProfile(store, roomId, { actorId, memberId, profile: resolved });
  return { unchanged: false, member: store.room(roomId).state.members[memberId] };
}

// Shadow admission journal for the route-table redeem. Same record as the
// legacy handler. Never throws.
export function journalAgentInviteAdmission(store, remoteAddress, { roomId, identityId = null, displayName = "" } = {}) {
  try {
    if (!store?.jevShadow || typeof roomId !== "string" || !roomId) return;
    const now = store.now();
    const members = Object.values(store.room(roomId).state.members ?? {});
    const resolvedDisplayName = typeof displayName === "string" ? displayName : "";
    const identity = identityId ? store.identities.get(identityId) : null;
    const ipHash = rateHash(String(remoteAddress ?? ""));
    const isSelf = member => Boolean(member) && identityId && member.identityId === identityId;
    let droppedSelf = members.some(isSelf);
    const existingDisplayNames = [];
    for (const member of members) {
      if (!member || member.active === false || typeof member.displayName !== "string") continue;
      if (isSelf(member)) continue;
      if (!droppedSelf && resolvedDisplayName
        && member.displayName.toLowerCase().trim() === resolvedDisplayName.toLowerCase().trim()) {
        droppedSelf = true;
        continue;
      }
      existingDisplayNames.push(member.displayName);
    }
    const decision = evaluateAdmission({
      identityId, displayName: resolvedDisplayName, path: "agent-invite:redeem",
      identityAgeMs: identity && Number.isFinite(identity.createdAt) ? Math.max(0, now - identity.createdAt) : null,
      existingDisplayNames,
      recentJoins: {
        byIdentity: identityId ? store.jevShadow.recentJoinCount({ identityId, windowMs: jevVelocityWindowMs }) : 0,
        byIp: store.jevShadow.recentJoinCount({ ipHash, windowMs: jevVelocityWindowMs }),
      },
      card: null, at: now,
    });
    store.jevShadow.record({
      gate: "admission", roomId, identityId, ipHash, path: "agent-invite:redeem",
      score: decision.score, decision: decision.decision, escalate: false, signals: decision.signals, at: now,
    });
  } catch { /* shadow-only */ }
}

export function validRedeemRequestId(value) {
  return validId(value);
}
