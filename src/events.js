import { canonicalReaction, foldedReactionMap, MAX_REACTIONS_PER_MESSAGE } from "./emoji.js";
import { proposalContext, nativeTextEvidence, reportedProducer, validateResultSegments } from "./work-packet.js";
import { CHARTER_TYPE, charterFromEvent } from "./room-charter.js";
import { REPLY_CANCELLED, prepareReplyPost, recordReplyPost, cancelReplyRequest } from "./reply-requests.js";
import { WORK_HELP_UPDATED, helpFromEvent } from "./work-help.js";
import { HELP_OFFER_OPENED, HELP_OFFER_UPDATED, helpOfferFromEvent } from "./help-offers.js";
import { SESSION_EVENT_TYPES, applySessionFields, ensureWorkControlDefaults } from "./work-item-session.js";

// message.posted and message.edited bodies. Other event strings stay at 4,096.
// 65,536 characters is far under the 4 MiB room projection and Durable Object
// SQLite row limits. Worst-case JSON escaping is 6 bytes per character
// (\uXXXX), about 384 KiB, which fits the 512 KiB message command ceiling.
export const MAX_MESSAGE_BODY_CHARS = 65536;
export const MAX_MESSAGE_COMMAND_BYTES = 512 * 1024;

export const EVENT_TYPES = Object.freeze({
  ROOM_CREATED: "room.created",
  ROOM_CHARTER_UPDATED: CHARTER_TYPE,
  ROOM_POLICY_SET: "room.policy_set",
  ROOM_SPEND_ALLOWANCE_SET: "room.spend_allowance_set",
  // One owner kill-switch for cross-owner assign and wake. Default open.
  ROOM_TRUST_SET: "room.trust_set",
  ROOM_ARCHIVED: "room.archived",
  MEMBER_ADDED: "member.added",
  MEMBER_JOINED_VIA_INVITATION: "member.joined_via_invitation",
  MEMBER_ACCESS_CHANGED: "member.access_changed",
  MEMBER_STATUS_UPDATED: "member.status_updated",
  NOTIFICATION_PREFERENCES_SET: "notifications.preferences_set",
  MEMBER_MUTE_SET: "member.mute_set",
  MESSAGE_POSTED: "message.posted",
  MESSAGE_EDITED: "message.edited",
  MESSAGE_DELETED: "message.deleted",
  REPLY_REQUEST_CANCELLED: REPLY_CANCELLED,
  MESSAGE_REACTION_SET: "message.reaction_set",
  MESSAGE_PINNED: "message.pinned",
  MESSAGE_UNPINNED: "message.unpinned",
  CHANNEL_CREATED: "channel.created",
  CHANNEL_RENAMED: "channel.renamed",
  CHANNEL_ARCHIVED: "channel.archived",
  WORK_PROPOSED: "work.proposed",
  WORK_HELP_UPDATED,
  HELP_OFFER_OPENED,
  HELP_OFFER_UPDATED,
  WORK_ACCEPTED: "work.accepted",
  WORK_STARTED: "work.started",
  WORK_BLOCKED: "work.blocked",
  WORK_BLOCKER_RESOLVED: "work.blocker_resolved",
  WORK_COMPLETED: "work.completed",
  WORK_SUPERSEDED: "work.superseded",
  WORK_HANDOFF_RECORDED: "work.handoff_recorded",
  WORK_HALT_CLEARED: "work.halt_cleared",
  CLAIM_ACQUIRED: "claim.acquired",
  CLAIM_RELEASED: "claim.released",
  CLAIM_RENEWED: "claim.renewed",
  VERIFICATION_RECORDED: "verification.recorded",
  OWNER_DECISION_RECORDED: "owner.decision_recorded",
  DECISION_RECORDED: "decision.recorded",
  SESSION_STARTED: SESSION_EVENT_TYPES.STARTED,
  SESSION_STATUS_CHANGED: SESSION_EVENT_TYPES.STATUS_CHANGED,
  SESSION_STOP_REQUESTED: SESSION_EVENT_TYPES.STOP_REQUESTED,
  SESSION_STOPPED: SESSION_EVENT_TYPES.STOPPED,
  CAPABILITIES_ADVERTISED: "capabilities.advertised",
  OWNERSHIP_TRANSFERRED: "ownership.transferred",
  // RC-2026-09-19-071 (QAJ-006): a self-serve access request arrived. The
  // access_requests table stays the source of truth; this event is the
  // timeline-visible, notification-driving record. The handler validates the
  // envelope and records nothing in the projection — decisions mutate the
  // table, never the projection, so a projection copy would go stale.
  ACCESS_REQUESTED: "access.requested",
  // Referral attribution: a member joined because another member referred
  // them. The referrals table stays the source of truth (queryable for the
  // board/leaderboard); this event is the timeline-visible audit record.
  // The handler validates the envelope and records nothing in the
  // projection.
  REFERRAL_COMPLETED: "referral.completed",
  // Agent Bond receipts. Authorization lives in agent_bonds; these events
  // are the participant-visible ledger (not room chat, not a room broadcast).
  BOND_PROPOSED: "bond.proposed",
  BOND_ACTIVATED: "bond.activated",
  BOND_REVOKED: "bond.revoked",
  DM_POSTED: "dm.posted",
  // Land queue receipt. The land_queue table is the source of truth; this
  // event is the thin wake record (pr, head, state, what changed).
  LAND_UPDATED: "land.updated"
});

// Room channels (Phase 2 of the Discord/Slack-like redesign): every room has
// one main channel for chat and work plus optional user-created channels.
// Channels live on the projection (state.channels, keyed by id); messages
// carry channelId. Rooms created before channels existed backfill #general
// on replay via ensureDefaultChannel, so no data migration is needed.
export const DEFAULT_CHANNEL_ID = "general";
export const MAX_CHANNELS_PER_ROOM = 50;
export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,47}$/;

export function normalizeChannelName(name) {
  const normalized = typeof name === "string" ? name.trim().toLowerCase().replace(/\s+/g, "-") : "";
  if (!CHANNEL_NAME_PATTERN.test(normalized)) throw new Error("Channel name uses lowercase letters, numbers, dashes (1-48 chars)");
  return normalized;
}

export function messageChannelId(message) {
  return message?.channelId || DEFAULT_CHANNEL_ID;
}

export function channelList(state) {
  return Object.values(state.channels ?? {})
    .filter(channel => channel && typeof channel.id === "string")
    .sort((a, b) => (a.id === DEFAULT_CHANNEL_ID ? -1 : b.id === DEFAULT_CHANNEL_ID ? 1 : 0)
      || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function ensureDefaultChannel(state, at) {
  if (!state.room) return;
  state.channels ??= {};
  state.channels[DEFAULT_CHANNEL_ID] ??= {
    id: DEFAULT_CHANNEL_ID,
    name: DEFAULT_CHANNEL_ID,
    createdBy: state.room.ownerId,
    createdAt: state.room.createdAt ?? at,
    archivedAt: null
  };
}

// Room policy (issue #6 A4): the owner can make independent review and/or an
// owner decision mandatory for every work item proposed afterwards. The policy
// is event-sourced (room.policy_set) and lives on the projection; work recorded
// before a flip keeps the requirements it was recorded with. Off is the default
// and the pre-policy behaviour: the proposer chooses per item.
export const ROOM_POLICY_FIELDS = Object.freeze(["requireIndependentReview", "requireOwnerDecision"]);

export function roomPolicy(state) {
  const stored = state?.room?.policy ?? {};
  return Object.fromEntries(ROOM_POLICY_FIELDS.map(field => [field, stored[field] === true]));
}

// Room Trust is one binary kill-switch, separate from Bond and from review
// policy. Default is open: no stored value means cross-owner assign and wake
// stay allowed for members. The owner flips it off with room.trust_set.
// Rooms that never record the event keep no `room.trust` field, so replay of
// older logs stays byte-identical.
export const TRUST_OFF_CODE = "trust_off";
export const trustOffMessage = targetId =>
  `Room Trust is off: cross-owner assign and wake are blocked${targetId ? ` (${targetId})` : ""}. Ask the room owner to turn Trust on.`;

export function roomTrust(state) {
  const stored = state?.room?.trust;
  if (!stored || typeof stored.enabled !== "boolean") return { enabled: true };
  return {
    enabled: stored.enabled,
    revision: Number.isSafeInteger(stored.revision) ? stored.revision : 0,
    setById: typeof stored.setById === "string" ? stored.setById : null,
    setAt: typeof stored.setAt === "string" ? stored.setAt : null
  };
}

// Humans own themselves. An agent belongs to its accountable human, or to
// the room owner when that sponsor was never recorded.
export function memberOwnerId(state, memberId) {
  const member = state?.members?.[memberId];
  if (!member) return null;
  if (typeof member.accountableHumanId === "string" && member.accountableHumanId) return member.accountableHumanId;
  if (member.kind === "human") return member.id;
  return state?.room?.ownerId ?? null;
}

export function distinctMemberOwnerIds(state) {
  const owners = new Set();
  for (const member of Object.values(state?.members ?? {})) {
    if (!member || member.active === false) continue;
    const ownerId = memberOwnerId(state, member.id);
    if (ownerId) owners.add(ownerId);
  }
  return owners;
}

// Cross-owner means the two members have different sponsors and at least
// one of them is an agent. Two humans coordinating are not this gate.
export function isCrossOwnerAgentAction(state, actorId, targetId) {
  if (!actorId || !targetId || actorId === targetId) return false;
  const actor = state?.members?.[actorId];
  const target = state?.members?.[targetId];
  if (!actor || !target || actor.active === false || target.active === false) return false;
  if (actor.kind !== "agent" && target.kind !== "agent") return false;
  const ownerA = memberOwnerId(state, actorId);
  const ownerB = memberOwnerId(state, targetId);
  return Boolean(ownerA && ownerB && ownerA !== ownerB);
}

export function roomTrustBlocks(state, actorId, targetId) {
  return roomTrust(state).enabled === false && isCrossOwnerAgentAction(state, actorId, targetId);
}

export function assertRoomTrust(state, actorId, targetId) {
  if (!roomTrustBlocks(state, actorId, targetId)) return;
  const error = new Error(trustOffMessage(targetId));
  error.code = TRUST_OFF_CODE;
  throw error;
}

export function firstBlockedWakeTarget(state, actorId, targetIds) {
  if (roomTrust(state).enabled !== false || !Array.isArray(targetIds)) return null;
  for (const targetId of targetIds) {
    if (isCrossOwnerAgentAction(state, actorId, targetId)) return targetId;
  }
  return null;
}

// Room lifecycle (issue #6 A2). `kind` is a creation-time attribute: the
// personal / organization badge until a real organization model (D1) exists;
// rooms created before it read as personal. Archive is an owner-only event
// (room.archived) that turns the room read-only: reads, streams and export
// continue, and no further event of any type is accepted for that room. A
// member leaves by ending their own access (member.access_changed on
// themself, permissions unchanged, active false) without needing
// manage_members; the owner cannot leave.
export const ROOM_KINDS = Object.freeze(["personal", "organization"]);
export const roomKind = room => (ROOM_KINDS.includes(room?.kind) ? room.kind : "personal");
export const isRoomArchived = state => typeof state?.room?.archivedAt === "string";
export function isLeaveRequest(state, incoming) {
  const member = Object.hasOwn(state.members, String(incoming.data?.memberId)) && state.members[incoming.data.memberId];
  return Boolean(member) && incoming.actorId === member.id && member.active === true && incoming.data.active === false
    && Array.isArray(incoming.data.permissions) && JSON.stringify(incoming.data.permissions) === JSON.stringify(member.permissions);
}

// Room spend allowance (issue #6 C3): the owner can cap what agent sessions
// in this room may spend over a rolling period. Event-sourced
// (room.spend_allowance_set) and carried on the projection;
// server/spend-allowance.mjs refuses session starts that would commit more
// than the allowance. allowanceCents null clears it. No allowance is the
// default and the pre-allowance behaviour: sessions bound only themselves.
export const SPEND_ALLOWANCE_LIMITS = Object.freeze({ allowanceCents: 100000000, periodDays: 365 });

export function spendAllowance(state) {
  const stored = state?.room?.spendAllowance;
  if (!stored || !Number.isSafeInteger(stored.allowanceCents) || stored.allowanceCents < 0) return null;
  return { allowanceCents: stored.allowanceCents, periodDays: stored.periodDays, revision: stored.revision, setById: stored.setById, setAt: stored.setAt };
}

function setSpendAllowance(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may set the spend allowance");
  const { allowanceCents, periodDays } = incoming.data;
  const clearing = allowanceCents === null;
  if (!clearing && (!Number.isSafeInteger(allowanceCents) || allowanceCents < 0 || allowanceCents > SPEND_ALLOWANCE_LIMITS.allowanceCents)) {
    throw new Error(`allowanceCents must be an integer of cents from 0 to ${SPEND_ALLOWANCE_LIMITS.allowanceCents}, or null to remove the allowance`);
  }
  if (!clearing && (!Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > SPEND_ALLOWANCE_LIMITS.periodDays)) {
    throw new Error(`periodDays must be an integer from 1 to ${SPEND_ALLOWANCE_LIMITS.periodDays}`);
  }
  if (clearing && periodDays != null) throw new Error("Removing the allowance takes no period");
  const previous = state.room.spendAllowance ?? null;
  state.room.spendAllowance = {
    allowanceCents: clearing ? null : allowanceCents,
    periodDays: clearing ? null : periodDays,
    revision: (previous?.revision ?? 0) + 1,
    setById: incoming.actorId,
    setAt: incoming.at
  };
}

export const PERMISSIONS = Object.freeze(["steer", "decide", "manage_members", "manage_claims", "accept_work", "complete_work", "verify", "write_external", "invite_member"]);
// Default autonomy for collaborating agents: they can steer, take work,
// complete it, and verify. Attenuated: no manage_members / decide /
// write_external / invite_member (those stay owner or explicit identity-link).
export const AGENT_AUTONOMY_PERMISSIONS = Object.freeze(["steer", "accept_work", "complete_work", "verify"]);
// Agent-safe standing invite scope (chat/contribute/review/collaborate).
// invite_member holders may mint these without holding them; they cannot
// grant manage_members/decide/invite_member via invite-code.
export const AGENT_INVITE_SAFE_PERMISSIONS = AGENT_AUTONOMY_PERMISSIONS;
export const AGENT_ADMIN_PERMISSIONS = Object.freeze(["manage_members", "decide"]);

// Owner, manage_members, or invite_member (agents may hold invite_member
// without manage_members/decide). Used by invite-code mint/redeem.
export function canInviteMembers(state, memberId) {
  const member = state?.members?.[memberId];
  if (!member || member.active === false) return false;
  if (memberId === state.room?.ownerId) return true;
  return member.permissions.includes("manage_members") || member.permissions.includes("invite_member");
}

// A command may check a work revision without advancing it (for example help).
// Historical evidence readers must not infer a mutation from a field name alone.
export const WORK_REVISION_TYPES = Object.freeze([
  EVENT_TYPES.WORK_ACCEPTED, EVENT_TYPES.WORK_STARTED, EVENT_TYPES.WORK_BLOCKED, EVENT_TYPES.WORK_BLOCKER_RESOLVED,
  EVENT_TYPES.WORK_COMPLETED, EVENT_TYPES.WORK_SUPERSEDED, EVENT_TYPES.CLAIM_ACQUIRED, EVENT_TYPES.CLAIM_RELEASED,
  EVENT_TYPES.CLAIM_RENEWED, EVENT_TYPES.VERIFICATION_RECORDED, EVENT_TYPES.OWNER_DECISION_RECORDED,
  EVENT_TYPES.SESSION_STARTED, EVENT_TYPES.SESSION_STATUS_CHANGED, EVENT_TYPES.SESSION_STOP_REQUESTED,
  EVENT_TYPES.SESSION_STOPPED, EVENT_TYPES.WORK_HANDOFF_RECORDED
]);

// Roles are human-readable presets. The stored permission snapshot remains the
// authority so a later role-policy change cannot silently widen an invitation.
export const INVITATION_ROLE_POLICIES = Object.freeze({
  1: Object.freeze({
    moderator: Object.freeze(["steer", "manage_members", "manage_claims", "accept_work", "complete_work", "verify"]),
    member: Object.freeze(["accept_work", "complete_work", "verify"]),
    guest: Object.freeze([])
  })
});
export const INVITATION_ROLE_POLICY_VERSION = 1;
export const INVITATION_ROLES = INVITATION_ROLE_POLICIES[INVITATION_ROLE_POLICY_VERSION];
export const MEMBERSHIP_AUTHORITY_POLICY_VERSION = 2;

export function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
}

export const WORK_STATES = Object.freeze({
  PROPOSED: "proposed",
  ACCEPTED: "accepted",
  WORKING: "working",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  SUPERSEDED: "superseded"
});

export function emptyRoomState() {
  return {
    room: null,
    members: {},
    channels: {},
    messages: [],
    workItems: {},
    eventLog: [],
    seenEvents: {},
    seenIdempotencyKeys: {}
  };
}

export function event(overrides) {
  if (!overrides?.type || !overrides?.actorId || !overrides?.roomId) {
    throw new Error("Events require type, actorId, and roomId");
  }
  return {
    id: overrides.id || crypto.randomUUID(),
    idempotencyKey: overrides.idempotencyKey || crypto.randomUUID(),
    roomId: overrides.roomId,
    type: overrides.type,
    actorId: overrides.actorId,
    at: overrides.at || new Date().toISOString(),
    causationId: overrides.causationId || null,
    data: overrides.data || {}
  };
}

export function replay(events) {
  return events.reduce((state, next) => applyEvent(state, next), emptyRoomState());
}

export function applyEvent(current, incoming) {
  const state = structuredClone(current);
  validateEnvelope(incoming);
  const fingerprint = stableStringify(incoming);

  if (state.seenEvents[incoming.id]) {
    if (state.seenEvents[incoming.id] !== fingerprint) throw new Error("Conflicting reuse of event id");
    return state;
  }
  if (state.seenIdempotencyKeys[incoming.idempotencyKey]) {
    const earlierId = state.seenIdempotencyKeys[incoming.idempotencyKey];
    if (state.seenEvents[earlierId] !== fingerprint) throw new Error("Conflicting reuse of idempotency key");
    return state;
  }

  if (incoming.type !== EVENT_TYPES.ROOM_CREATED) {
    if (!state.room) throw new Error("Room must be created before other events");
    if (incoming.roomId !== state.room.id) throw new Error("Event belongs to a different Room");
    if (isRoomArchived(state)) throw new Error("Room is archived");
  }

  const handlers = {
    [EVENT_TYPES.ROOM_CREATED]: createRoom,
    [EVENT_TYPES.ROOM_CHARTER_UPDATED]: updateCharter,
    [EVENT_TYPES.ROOM_POLICY_SET]: setRoomPolicy,
    [EVENT_TYPES.ROOM_SPEND_ALLOWANCE_SET]: setSpendAllowance,
    [EVENT_TYPES.ROOM_TRUST_SET]: setRoomTrust,
    [EVENT_TYPES.ROOM_ARCHIVED]: archiveRoom,
    [EVENT_TYPES.OWNERSHIP_TRANSFERRED]: transferOwnership,
    [EVENT_TYPES.MEMBER_ADDED]: addMember,
    [EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION]: joinMemberViaInvitation,
    [EVENT_TYPES.MEMBER_ACCESS_CHANGED]: changeMemberAccess,
    [EVENT_TYPES.MEMBER_STATUS_UPDATED]: updateMemberStatus,
    [EVENT_TYPES.NOTIFICATION_PREFERENCES_SET]: setNotificationPreferences,
    [EVENT_TYPES.MEMBER_MUTE_SET]: setMemberMute,
    [EVENT_TYPES.MESSAGE_POSTED]: postMessage,
    [EVENT_TYPES.MESSAGE_EDITED]: editMessage,
    [EVENT_TYPES.MESSAGE_DELETED]: deleteMessage,
    [EVENT_TYPES.REPLY_REQUEST_CANCELLED]: cancelReplyRequest,
    [EVENT_TYPES.MESSAGE_REACTION_SET]: setMessageReaction,
    [EVENT_TYPES.MESSAGE_PINNED]: pinMessage,
    [EVENT_TYPES.MESSAGE_UNPINNED]: unpinMessage,
    [EVENT_TYPES.CHANNEL_CREATED]: createChannel,
    [EVENT_TYPES.CHANNEL_RENAMED]: renameChannel,
    [EVENT_TYPES.CHANNEL_ARCHIVED]: archiveChannel,
    [EVENT_TYPES.WORK_PROPOSED]: proposeWork,
    [EVENT_TYPES.WORK_HELP_UPDATED]: (state, incoming) => {
      const help = helpFromEvent(state, incoming);
      state.workItems[help.workItemId].helpWanted = help;
    },
    [EVENT_TYPES.WORK_ACCEPTED]: acceptWork,
    [HELP_OFFER_OPENED]: recordHelpOffer,
    [HELP_OFFER_UPDATED]: recordHelpOffer,
    [EVENT_TYPES.WORK_STARTED]: startWork,
    [EVENT_TYPES.WORK_HANDOFF_RECORDED]: recordHandoff,
    [EVENT_TYPES.WORK_HALT_CLEARED]: clearHalt,
    [EVENT_TYPES.WORK_BLOCKED]: blockWork,
    [EVENT_TYPES.WORK_BLOCKER_RESOLVED]: resolveBlocker,
    [EVENT_TYPES.WORK_COMPLETED]: completeWork,
    [EVENT_TYPES.WORK_SUPERSEDED]: supersedeWork,
    [EVENT_TYPES.CLAIM_ACQUIRED]: acquireClaim,
    [EVENT_TYPES.CLAIM_RELEASED]: releaseClaim,
    [EVENT_TYPES.CLAIM_RENEWED]: renewClaim,
    [EVENT_TYPES.VERIFICATION_RECORDED]: recordVerification,
    [EVENT_TYPES.OWNER_DECISION_RECORDED]: recordOwnerDecision,
    [EVENT_TYPES.DECISION_RECORDED]: recordDecision,
    [EVENT_TYPES.SESSION_STARTED]: applySession,
    [EVENT_TYPES.SESSION_STATUS_CHANGED]: applySession,
    [EVENT_TYPES.SESSION_STOP_REQUESTED]: applySession,
    [EVENT_TYPES.SESSION_STOPPED]: applySession,
    [EVENT_TYPES.CAPABILITIES_ADVERTISED]: advertiseCapabilities,
    [EVENT_TYPES.ACCESS_REQUESTED]: recordAccessRequest,
    [EVENT_TYPES.REFERRAL_COMPLETED]: recordReferral,
    [EVENT_TYPES.BOND_PROPOSED]: recordBond,
    [EVENT_TYPES.BOND_ACTIVATED]: recordBond,
    [EVENT_TYPES.BOND_REVOKED]: recordBond,
    [EVENT_TYPES.DM_POSTED]: recordPeerDm,
    [EVENT_TYPES.LAND_UPDATED]: recordLandUpdate
  };
  const handler = handlers[incoming.type];
  if (!Object.hasOwn(handlers, incoming.type)) throw new Error(`Unsupported event type: ${incoming.type}`);
  // Legacy rooms (created before channels) gain #general here, before any
  // handler reads state.channels. New rooms seed it in createRoom, so this
  // is a no-op for them; createRoom itself runs with state.room unset, which
  // the ensure skips.
  ensureDefaultChannel(state, incoming.at);
  handler(state, incoming);
  // Work controls predate some stored projections: backfill the round /
  // tool-call counters, suspension cause, and receipt segments on replay.
  // Runs after the handler so newly created items gain the defaults too.
  ensureWorkControlDefaults(state);
  state.eventLog.push(incoming);
  state.seenEvents[incoming.id] = fingerprint;
  state.seenIdempotencyKeys[incoming.idempotencyKey] = incoming.id;
  return state;
}

function recordHelpOffer(state, incoming) {
  const offer = helpOfferFromEvent(state, incoming);
  (state.helpOffers ??= {})[offer.id] = offer;
}

function validateEnvelope(incoming) {
  for (const key of ["id", "idempotencyKey", "roomId", "type", "actorId", "at"]) {
    if (!incoming?.[key]) throw new Error(`Event missing ${key}`);
  }
  if (Number.isNaN(Date.parse(incoming.at))) throw new Error("Event at must be an ISO date");
  for (const key of ["id", "idempotencyKey", "roomId", "actorId"]) {
    if (!validId(incoming[key])) throw new Error(`Invalid ${key}`);
  }
  if (!incoming.data || Array.isArray(incoming.data) || typeof incoming.data !== "object") throw new Error("Event data must be an object");
  for (const [key, value] of Object.entries(incoming.data)) {
    if (value === null) continue;
    if (key.endsWith("Id") && !validId(value)) throw new Error(`Invalid ${key}`);
    if (typeof value === "string") {
      const messageBody = key === "body" && (incoming.type === EVENT_TYPES.MESSAGE_POSTED || incoming.type === EVENT_TYPES.MESSAGE_EDITED);
      const limit = messageBody ? MAX_MESSAGE_BODY_CHARS : 4096;
      if (!value.trim() || value.length > limit) {
        if (messageBody && value.trim()) throw new Error(`body must be at most ${MAX_MESSAGE_BODY_CHARS} characters`);
        throw new Error(`Invalid ${key}`);
      }
    }
    if (["expectedRevision", "expectedMemberRevision"].includes(key) && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid ${key}`);
    if (["independentVerificationRequired", "ownerDecisionRequired", "active", ...ROOM_POLICY_FIELDS].includes(key) && typeof value !== "boolean") throw new Error(`Invalid ${key}`);
    if (["permissions", "paths", "checksClaimed", "capabilities", "scopes", "acceptedScopes"].includes(key) && (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== "string" || !v.trim() || v.length > 512))) throw new Error(`Invalid ${key}`);
    // Legacy events (v11-v18) used data.outputs as a plain string; keep that shape valid for strict replay.
    if (key === "outputs" && typeof value !== "string" && (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== "string" || !v.trim() || v.length > 512))) throw new Error(`Invalid ${key}`);
    if (key === "preferences" && (Array.isArray(value) || typeof value !== "object" || Object.entries(value).some(([k, v]) => typeof k !== "string" || typeof v !== "string" || k.length > 64 || v.length > 64))) throw new Error(`Invalid ${key}`);
    // RC-2026-09-19-063: fact/inference/proposal marks. The envelope guard is
    // coarse (shape only); the applier runs the full segment validator.
    if (key === "segments" && (!Array.isArray(value) || value.length === 0 || value.length > 20
      || value.some(segment => !segment || typeof segment !== "object" || Array.isArray(segment)
        || typeof segment.kind !== "string" || typeof segment.text !== "string"))) throw new Error(`Invalid ${key}`);
    // land.updated carries a thin wake payload: state is the check/behind
    // rollup and changed is which of green, red, behind, merged, or tip flipped.
    if (key === "changed" && (!Array.isArray(value) || value.length < 1 || value.length > 5
      || value.some(change => typeof change !== "string" || !["green", "red", "behind", "merged", "tip"].includes(change)))) throw new Error(`Invalid ${key}`);
    if (key === "state" && (!value || typeof value !== "object" || Array.isArray(value)
      || !["pending", "green", "red"].includes(value.checks)
      || typeof value.behind !== "boolean"
      || !["mergeable", "behind", "conflict", "unknown", "merged"].includes(value.mergeable)
      || typeof value.merged !== "boolean")) throw new Error(`Invalid ${key}`);
    if (!["string", "boolean", "number"].includes(typeof value) && !["permissions", "paths", "checksClaimed", "capabilities", "preferences", "budget", "outputs", "segments", "signedEvidence", "labels", "scopes", "acceptedScopes", "changed", "state"].includes(key)) throw new Error(`Invalid ${key}`);
  }
}

function createRoom(state, incoming) {
  if (state.room) throw new Error("Room already exists");
  requireFields(incoming.data, ["roomId", "title", "purpose", "ownerId"]);
  if (incoming.data.kind !== undefined && !ROOM_KINDS.includes(incoming.data.kind)) throw new Error("Room kind must be personal or organization");
  if (incoming.roomId !== incoming.data.roomId) throw new Error("Room event id mismatch");
  if (incoming.actorId !== incoming.data.ownerId) throw new Error("Room must be created by its owner");
  state.room = { id: incoming.data.roomId, ...incoming.data, createdAt: incoming.at };
  state.channels = {
    [DEFAULT_CHANNEL_ID]: {
      id: DEFAULT_CHANNEL_ID,
      name: DEFAULT_CHANNEL_ID,
      createdBy: incoming.actorId,
      createdAt: incoming.at,
      archivedAt: null
    }
  };
}

function updateCharter(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  // Room-scoped owner power: an agent owner may set instructions, so the
  // gate is ownership, not humanity. Account-bound powers (spend
  // allowance, access review, connection sponsorship) stay human-only.
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may change room instructions");
  state.room.charter = charterFromEvent(incoming, state.room.charter ?? null);
}

function setRoomPolicy(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may set room policy");
  for (const field of ROOM_POLICY_FIELDS) {
    if (typeof incoming.data[field] !== "boolean") throw new Error(`Room policy requires ${field} as true or false`);
  }
  const previous = state.room.policy ?? null;
  state.room.policy = {
    requireIndependentReview: incoming.data.requireIndependentReview,
    requireOwnerDecision: incoming.data.requireOwnerDecision,
    revision: (previous?.revision ?? 0) + 1,
    setById: incoming.actorId,
    setAt: incoming.at
  };
}

function setRoomTrust(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may set Room Trust");
  if (typeof incoming.data.enabled !== "boolean") throw new Error("Room Trust requires enabled as true or false");
  const previous = state.room.trust ?? null;
  state.room.trust = {
    enabled: incoming.data.enabled,
    revision: (previous?.revision ?? 0) + 1,
    setById: incoming.actorId,
    setAt: incoming.at
  };
}

function archiveRoom(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may archive the room");
  if (incoming.data.reason != null && (typeof incoming.data.reason !== "string" || incoming.data.reason.length > 280)) throw new Error("Archive reason must be 280 characters or fewer");
  state.room.archivedAt = incoming.at;
  state.room.archivedById = incoming.actorId;
  if (incoming.data.reason) state.room.archiveReason = incoming.data.reason;
}

// Ownership is transferable: the current owner appoints an existing active
// member (human or agent) as the new owner. Only the owner can transfer, so
// there is no privilege escalation; the transfer is reversible by another
// transfer. The event log is the audit trail; the projection keeps only
// scalar current/previous-owner fields, never a history array.
// Ownership implies full authority, so the new owner receives
// the whole permission set (a bootstrap owner's set), whatever its kind —
// otherwise an agent owner would be a figurehead unable to administer
// membership. An agent that ceases to be the owner is stripped of
// manage_members/decide on the way out, because non-owner agents can never
// hold those (validatePermissions). A human ex-owner keeps its snapshot;
// the new owner can demote it explicitly.
function transferOwnership(state, incoming) {
  requireFields(incoming.data, ["toMemberId"]);
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may transfer ownership");
  // Unknown and inactive targets share one error so member enumeration is
  // impossible; the module maps it to a bare 404.
  const target = Object.hasOwn(state.members, incoming.data.toMemberId) && state.members[incoming.data.toMemberId];
  if (!target || target.active === false) throw new Error("Unknown member");
  if (target.id === state.room.ownerId) throw new Error("Already the room owner");
  if (incoming.data.reason != null && (typeof incoming.data.reason !== "string" || incoming.data.reason.length > 280)) {
    throw new Error("Transfer reason must be 280 characters or fewer");
  }
  const previous = state.room.ownerId;
  const previousOwner = state.members[previous];
  target.permissions = [...PERMISSIONS];
  target.revision += 1;
  // Ownership supersedes delegation: the new owner is authoritative in its
  // own right, never a delegated admin.
  delete target.delegatedAdmin;
  if (previousOwner && previousOwner.kind === "agent") {
    previousOwner.permissions = previousOwner.permissions.filter(p => !["manage_members", "decide"].includes(p));
    previousOwner.revision += 1;
    // Admin bits are stripped on the way out, so the marker goes too.
    delete previousOwner.delegatedAdmin;
  }
  state.room.ownerId = target.id;
  state.room.previousOwnerId = previous;
  state.room.ownershipTransferredAt = incoming.at;
  state.room.ownershipRevision = (state.room.ownershipRevision ?? 0) + 1;
}

function addMember(state, incoming) {
  requireFields(incoming.data, ["memberId", "displayName", "kind", "permissions"]);
  const memberId = incoming.data.memberId;
  if (state.members[memberId]) throw new Error("Member already exists");
  const isBootstrapOwner = Object.keys(state.members).length === 0 && memberId === state.room.ownerId;
  if (isBootstrapOwner && incoming.actorId !== memberId) throw new Error("Only the owner may bootstrap membership");
  if (!isBootstrapOwner) {
    const agentSafeInvite = incoming.data.kind === "agent"
      && Array.isArray(incoming.data.permissions)
      && !incoming.data.permissions.some(p => AGENT_ADMIN_PERMISSIONS.includes(p));
    if (agentSafeInvite) {
      if (!canInviteMembers(state, incoming.actorId)) throw new Error(`${incoming.actorId} lacks invite_member`);
    } else {
      requirePermission(state, incoming.actorId, "manage_members");
    }
  }
  if (!["human", "agent"].includes(incoming.data.kind)) throw new Error("Member kind must be human or agent");
  // #643 owner-delegated administration: a non-owner agent may hold
  // AGENT_ADMIN_PERMISSIONS only when the grant event's actor is the room
  // owner. The grant is explicit, auditable (actorId on the event), and
  // marked on the event + projection via delegatedAdmin below.
  const isOwnerGrant = !isBootstrapOwner && incoming.actorId === state.room.ownerId;
  validatePermissions(incoming.data.permissions, incoming.data.kind, isBootstrapOwner, isOwnerGrant);
  if (!isBootstrapOwner && incoming.data.authorityPolicyVersion === MEMBERSHIP_AUTHORITY_POLICY_VERSION) {
    requireScopedMemberAdministration(state, incoming.actorId, memberId, null, incoming.data.permissions);
  } else if (incoming.data.authorityPolicyVersion != null && incoming.data.authorityPolicyVersion !== 1) {
    throw new Error("Unsupported membership authority policy");
  }
  if (incoming.data.accountableHumanId && (!isBootstrapOwner || incoming.data.accountableHumanId !== memberId)) {
    if (requireMember(state, incoming.data.accountableHumanId).kind !== "human") throw new Error("Accountable sponsor must be a human member");
  }
  if (isBootstrapOwner && !incoming.data.permissions.includes("manage_members")) throw new Error("Owner must retain membership administration");
  // Round-2 #101: a member record may be bound to a global agent identity.
  if (incoming.data.identityId != null
    && (typeof incoming.data.identityId !== "string" || incoming.data.identityId.length > 64)) throw new Error("identityId must be a short string");
  if (incoming.data.agentType != null
    && (typeof incoming.data.agentType !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(incoming.data.agentType))) {
    throw new Error("agentType must be a short catalog id");
  }
  // Referral attribution: optional, validated, never self-referential. The
  // referrer must already be a member — checked at record time; the event
  // handler guards the shape so a corrupt log cannot forge it.
  if (incoming.data.referredBy != null) {
    if (typeof incoming.data.referredBy !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(incoming.data.referredBy)) {
      throw new Error("referredBy must be a member id");
    }
    if (incoming.data.referredBy === memberId) throw new Error("a member cannot refer themselves");
    const referrer = state.members?.[incoming.data.referredBy];
    if (!referrer || referrer.active === false) throw new Error("referredBy must be an active member");
  }
  state.members[memberId] = {
    id: memberId,
    displayName: incoming.data.displayName,
    kind: incoming.data.kind,
    // Round-2 #101: only present when the member was linked from an agent
    // identity; kept conditional so stored projections from before this field
    // rebuild byte-identically.
    ...(incoming.data.identityId === undefined ? {} : { identityId: incoming.data.identityId }),
    // Referral attribution: the member ID that referred this member, set at
    // join time from the invite's minter or a matched "who referred you?"
    // answer. Omitted otherwise so older projections replay byte-identically.
    ...(incoming.data.referredBy ? { referredBy: incoming.data.referredBy } : {}),
    // First-party Connect catalog type. Omitted on older members so replay stays
    // byte-identical. Not a marketplace listing.
    ...(incoming.data.agentType ? { agentType: incoming.data.agentType } : {}),
    accountableHumanId: incoming.data.accountableHumanId || (incoming.data.kind === "human" ? memberId : state.room.ownerId),
    permissions: [...incoming.data.permissions],
    // #643: explicit delegation marker. Set only when the owner granted
    // admin bits to a non-owner agent — cheaper to query than deriving the
    // grant class from the log, and inspectable (access-review surfaces it).
    // Omitted otherwise so older projections replay byte-identically.
    ...(isOwnerGrant && incoming.data.kind === "agent" && incoming.data.permissions.some(p => AGENT_ADMIN_PERMISSIONS.includes(p)) ? { delegatedAdmin: true } : {}),
    availability: incoming.data.availability || "unknown",
    active: true,
    revision: 0
  };
  // The member.added event itself carries the marker, so the grant class is
  // visible on the immutable log, not just the projection.
  if (isOwnerGrant && incoming.data.kind === "agent" && incoming.data.permissions.some(p => AGENT_ADMIN_PERMISSIONS.includes(p))) {
    incoming.data.delegatedAdmin = true;
  }
}

function joinMemberViaInvitation(state, incoming) {
  requireFields(incoming.data, ["memberId", "displayName", "role", "permissions", "invitedByMemberId", "invitationId", "rolePolicyVersion", "authorityPolicyVersion"]);
  const { memberId, invitedByMemberId, invitationId, role, permissions, rolePolicyVersion, authorityPolicyVersion } = incoming.data;
  if (incoming.actorId !== memberId) throw new Error("An invited member must join as themself");
  if (state.members[memberId]) throw new Error("Member already exists");
  requirePermission(state, invitedByMemberId, "manage_members");
  const rolePolicy = INVITATION_ROLE_POLICIES[rolePolicyVersion];
  const rolePermissions = rolePolicy && Object.hasOwn(rolePolicy, role) && rolePolicy[role];
  if (!rolePermissions || permissions.length !== rolePermissions.length || permissions.some((permission, index) => permission !== rolePermissions[index])) {
    throw new Error("Invitation role permissions do not match the stored role policy");
  }
  if (authorityPolicyVersion !== MEMBERSHIP_AUTHORITY_POLICY_VERSION) throw new Error("Unsupported membership authority policy");
  validatePermissions(permissions, "human");
  requireScopedMemberAdministration(state, invitedByMemberId, memberId, null, permissions);
  state.members[memberId] = {
    id: memberId,
    displayName: incoming.data.displayName,
    kind: "human",
    role,
    accountableHumanId: memberId,
    permissions: [...permissions],
    availability: "unknown",
    active: true,
    revision: 0,
    membershipOrigin: { kind: "invitation", invitationId, invitedByMemberId }
  };
}

function validatePermissions(permissions, kind, isOwner = false, isOwnerGrant = false) {
  if (!Array.isArray(permissions) || permissions.some(p => !PERMISSIONS.includes(p)) || new Set(permissions).size !== permissions.length) throw new Error("Invalid permissions");
  // Human administration cannot be delegated to an agent — except to the
  // room owner itself, or by the room owner's explicit grant (#643):
  // ownership implies full authority, so a bootstrap or appointed agent
  // owner holds the whole set like a human owner does, and the owner may
  // delegate administration to a non-owner agent. isOwnerGrant is threaded
  // by addMember/changeMemberAccess from the grant event's actorId.
  if (!isOwner && !isOwnerGrant && kind === "agent" && permissions.some(p => AGENT_ADMIN_PERMISSIONS.includes(p))) throw new Error("Human administration cannot be delegated to an agent");
}

function changeMemberAccess(state, incoming) {
  if (!isLeaveRequest(state, incoming)) requirePermission(state, incoming.actorId, "manage_members");
  requireFields(incoming.data, ["memberId", "expectedMemberRevision", "permissions", "active"]);
  const member = Object.hasOwn(state.members, incoming.data.memberId) && state.members[incoming.data.memberId];
  if (!member) throw new Error("Unknown member");
  if (member.revision !== incoming.data.expectedMemberRevision) throw new Error("Stale member revision");
  // #643: thread the owner-grant context like addMember does — the owner may
  // grant (or strip) administration on a non-owner agent.
  const isOwnerGrant = incoming.actorId === state.room.ownerId;
  validatePermissions(incoming.data.permissions, member.kind, false, isOwnerGrant);
  if (incoming.data.authorityPolicyVersion === MEMBERSHIP_AUTHORITY_POLICY_VERSION) {
    requireScopedMemberAdministration(state, incoming.actorId, member.id, member, incoming.data.permissions);
  } else if (incoming.data.authorityPolicyVersion != null && incoming.data.authorityPolicyVersion !== 1) {
    throw new Error("Unsupported membership authority policy");
  }
  if (member.id === state.room.ownerId && (!incoming.data.active || !incoming.data.permissions.includes("manage_members"))) throw new Error("Owner must retain membership administration");
  member.active = incoming.data.active;
  member.permissions = [...incoming.data.permissions];
  member.revision += 1;
  // #643: the delegation marker follows the bits. An owner grant of admin
  // bits to a non-owner agent sets it (on the projection and the
  // member.access_changed event); any other outcome clears it, so a
  // stripped or demoted agent never keeps the marker.
  if (isOwnerGrant && member.kind === "agent" && member.id !== state.room.ownerId
    && incoming.data.permissions.some(p => AGENT_ADMIN_PERMISSIONS.includes(p))) {
    member.delegatedAdmin = true;
    incoming.data.delegatedAdmin = true;
  } else {
    delete member.delegatedAdmin;
    delete incoming.data.delegatedAdmin;
  }
}

// A member's status message ("working on X"). Members set their own;
// the owner may set anyone's. If memberId is omitted, the caller is the
// target. Bounded length, no HTML — rendered as text.
function updateMemberStatus(state, incoming) {
  requireFields(incoming.data, ["message"]);
  requireMember(state, incoming.actorId);
  const targetId = incoming.data.memberId ?? incoming.actorId;
  const member = Object.hasOwn(state.members, targetId) && state.members[targetId];
  if (!member) throw new Error("Unknown member");
  if (member.active === false) throw new Error("Member access revoked");
  if (incoming.actorId !== member.id && incoming.actorId !== state.room.ownerId) {
    throw new Error("Members may only set their own status message");
  }
  const message = String(incoming.data.message ?? "");
  if (message.length > 140) throw new Error("Status message must be 140 characters or fewer");
  // A status line is presence, not authority: it must not move member.revision,
  // which pins open help invitations/offers and concurrent member.access_changed.
  member.statusMessage = message;
}

const NOTIFICATION_CHANNELS = ["mentions", "replies", "work_updates", "announcements"];
const NOTIFICATION_LEVELS = ["all", "mentions_only", "none"];

function setNotificationPreferences(state, incoming) {
  requireFields(incoming.data, ["preferences"]);
  const member = requireMember(state, incoming.actorId);
  const prefs = incoming.data.preferences;
  if (!prefs || Array.isArray(prefs) || typeof prefs !== "object") throw new Error("Preferences must be an object");
  for (const [channel, level] of Object.entries(prefs)) {
    if (!NOTIFICATION_CHANNELS.includes(channel)) throw new Error(`Unknown notification channel: ${channel}`);
    if (!NOTIFICATION_LEVELS.includes(level)) throw new Error(`Unknown notification level: ${level}`);
  }
  // Preferences are private delivery settings, not authority: only member.added
  // and member.access_changed move member.revision.
  member.notificationPreferences = { ...(member.notificationPreferences ?? defaultNotificationPreferences()), ...prefs };
}

export function defaultNotificationPreferences() {
  return { mentions: "all", replies: "all", work_updates: "all", announcements: "all" };
}

// Mute (issue #6 E4): a member hides another member's or agent's messages for
// themselves. It is a personal preference recorded like notification
// preferences (member.mute_set on the actor's own member record), never
// authority: the muted member keeps every permission, nothing is addressed
// at them, and the choice is reversible with muted:false. Clients collapse a
// muted author's messages and notification feeds skip them (server/moderation.mjs).
function setMemberMute(state, incoming) {
  requireFields(incoming.data, ["memberId", "muted"]);
  const actor = requireMember(state, incoming.actorId);
  const target = knownMember(state, incoming.data.memberId);
  if (typeof incoming.data.muted !== "boolean") throw new Error("Mute requires muted as true or false");
  if (target.id === actor.id) throw new Error("You cannot mute yourself");
  if (target.id === state.room.ownerId) throw new Error("The Room owner cannot be muted; the owner is the appeal path for moderation");
  const muted = new Set(actor.mutedMemberIds ?? []);
  if (incoming.data.muted) muted.add(target.id); else muted.delete(target.id);
  // A preference never moves member.revision (which pins open invitations and access changes).
  if (muted.size) actor.mutedMemberIds = [...muted].sort(); else delete actor.mutedMemberIds;
}

export function mutedMemberIds(state, viewerId) {
  return state?.members?.[viewerId]?.mutedMemberIds ?? [];
}

export function isMutedBy(state, viewerId, authorId) {
  return viewerId != null && authorId != null && mutedMemberIds(state, viewerId).includes(authorId);
}

function requireScopedMemberAdministration(state, actorId, targetId, currentTarget, nextPermissions) {
  if (actorId === state.room.ownerId) return;
  if (targetId === state.room.ownerId) throw new Error("Only the Room owner may change owner authority");
  const actor = requireMember(state, actorId);
  // #643: a delegated administrator may exercise its admin bits but never
  // bestow them. Without this rule the "can't grant what you don't hold"
  // check below would permit re-delegation, since the delegated admin
  // holds the bits. It can still approve access requests and change
  // non-admin permissions.
  if (actor.delegatedAdmin && nextPermissions.some(p => AGENT_ADMIN_PERMISSIONS.includes(p))) {
    throw new Error("Delegated administrators cannot re-delegate");
  }
  const affected = new Set([...(currentTarget?.permissions ?? []), ...nextPermissions]);
  // invite_member-only issuers may grant the standing agent-safe set
  // (chat/contribute/review/collaborate) without holding those bits themselves.
  const inviteOnly = actor.permissions.includes("invite_member") && !actor.permissions.includes("manage_members");
  if (inviteOnly) {
    if ([...affected].some(permission => !AGENT_INVITE_SAFE_PERMISSIONS.includes(permission))) {
      throw new Error("A membership administrator cannot grant or remove authority they do not hold");
    }
    return;
  }
  if ([...affected].some(permission => !actor.permissions.includes(permission))) {
    throw new Error("A membership administrator cannot grant or remove authority they do not hold");
  }
}

function postMessage(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["body"]);
  const requestMode = prepareReplyPost(state, incoming);
  if (incoming.data.toMemberId) (requestMode === "respond" ? knownMember : requireMember)(state, incoming.data.toMemberId);
  if (typeof incoming.data.body !== "string") throw new Error("Message body must be text");
  if (incoming.data.workItemId) requireWorkItem(state, incoming.data.workItemId);
  // Replies pin to their thread root's channel so a thread can't drift across
  // channels, no matter what channelId the command carries.
  let channelId = incoming.data.channelId || DEFAULT_CHANNEL_ID;
  if (incoming.data.replyToId) {
    let root = state.messages.find(m => m.id === incoming.data.replyToId);
    if (!root) throw new Error("Reply must reference a message in this Room");
    while (root.replyToId) {
      const parent = state.messages.find(m => m.id === root.replyToId);
      if (!parent) break;
      root = parent;
    }
    channelId = messageChannelId(root);
  }
  const channel = state.channels[channelId];
  if (!channel) throw new Error("Unknown channel");
  if (channel.archivedAt) throw new Error("Channel is archived");
  const proposal = proposalContext(incoming.data, state.workItems[incoming.data.workItemId]);
  if (state.messages.some(m => m.id === (incoming.data.messageId || incoming.id))) throw new Error("Message already exists");
  state.messages.push({
    id: incoming.data.messageId || incoming.id,
    authorId: actor.id,
    body: incoming.data.body,
    channelId,
    workItemId: incoming.data.workItemId || null,
    replyToId: incoming.data.replyToId || null,
    toMemberId: incoming.data.toMemberId || null,
    createdAt: incoming.at,
    ...(proposal ? { proposal } : {})
  });
  // "Also send to channel": a public thread reply also lands as a top-level
  // message in the thread's channel, in the same event. The derived id is
  // deterministic (validId-safe suffix) so replay and retried commands stay
  // idempotent. DMs and work proposals never copy — a DM copy would leak the
  // private body, and a proposal's work context doesn't survive as a plain
  // message.
  if (incoming.data.alsoSendToChannel && incoming.data.replyToId && !incoming.data.toMemberId && !incoming.data.workItemId) {
    const copyId = `${incoming.data.messageId || incoming.id}:channel`;
    if (state.messages.some(m => m.id === copyId)) throw new Error("Message already exists");
    state.messages.push({
      id: copyId,
      authorId: actor.id,
      body: incoming.data.body,
      channelId,
      workItemId: null,
      replyToId: null,
      toMemberId: null,
      createdAt: incoming.at
    });
  }
  recordReplyPost(state, incoming, requestMode);
}

function requireChannelOwner(state, actor) {
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may manage channels");
}

function createChannel(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["name"]);
  const name = normalizeChannelName(incoming.data.name);
  if (Object.keys(state.channels).length >= MAX_CHANNELS_PER_ROOM) throw new Error("Channel limit reached");
  if (Object.values(state.channels).some(c => c.name === name)) throw new Error("Channel name is taken");
  const id = incoming.data.channelId || incoming.id;
  if (state.channels[id]) throw new Error("Channel already exists");
  state.channels[id] = { id, name, createdBy: actor.id, createdAt: incoming.at, archivedAt: null };
}

function renameChannel(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireChannelOwner(state, actor);
  requireFields(incoming.data, ["channelId", "name"]);
  const channel = state.channels[incoming.data.channelId];
  if (!channel) throw new Error("Unknown channel");
  if (channel.archivedAt) throw new Error("Channel is archived");
  const name = normalizeChannelName(incoming.data.name);
  if (Object.values(state.channels).some(c => c.id !== channel.id && c.name === name)) throw new Error("Channel name is taken");
  channel.name = name;
}

function archiveChannel(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireChannelOwner(state, actor);
  requireFields(incoming.data, ["channelId"]);
  const channel = state.channels[incoming.data.channelId];
  if (!channel) throw new Error("Unknown channel");
  if (channel.id === DEFAULT_CHANNEL_ID) throw new Error("The main channel can't be archived");
  channel.archivedAt ??= incoming.at;
}
// A message named by a completed work item's receipt is that work's result.
// src/work-packet.js puts it plainly: "the immutable stored message is the
// artifact". Nothing enforced it, so an edit was accepted and then broke
// everything downstream at once - server/text-results.mjs storedText requires
// the posted body to still equal the stored one, so GET work-result answered
// 422 result_unavailable for that item forever while it went on reporting
// state: completed with an evidenceVersion hash matching nothing retrievable,
// and auditTextResults failed, which takes backupRoom down for the whole
// database.
//
// Scoped to receipts, deliberately. auditTextResults only walks work.completed
// events carrying room_text evidence, and a draft is meant to be revised.
//
// This refuses an owner's delete as well as an author's edit, which is the
// uncomfortable half: removing harmful content that happens to be bound as
// evidence now needs the receipt invalidated first, and there is no event for
// that yet. That is worth building. It is still better than the present
// behaviour, where the delete is accepted and silently destroys the artifact
// plus the room's backups, because a refusal says so at the moment it happens.
const evidenceReceipt = (state, messageId) => {
  for (const work of Object.values(state.workItems ?? {})) {
    for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
      if (receipt?.nativeText?.messageId === messageId) return work;
    }
  }
  return null;
};

// Withdrawing text a work item recorded as its result. The receipt keeps
// everything it ever claimed - who reported it, the hash a verifier signed off
// against - and gains the fact that the text behind it is gone, so a reader
// finds a withdrawal instead of a reference to a message the room no longer
// shows. Every auditor that reconstructs a receipt has to replay this; see
// auditTextResults in server/text-results.mjs.
function withdrawTextEvidence(state, messageId, incoming) {
  for (const work of Object.values(state.workItems ?? {})) {
    for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
      if (receipt?.nativeText?.messageId !== messageId) continue;
      receipt.nativeText.withdrawnAt = incoming.at;
      receipt.nativeText.withdrawnBy = incoming.actorId;
    }
  }
}

// `evidence: "refuse"` is for an edit, which would move the text behind a hash
// somebody already verified, leaving the work item claiming a result that no
// longer says what it said. `evidence: "withdraw"` is for a deletion, which
// must stay available to whoever has to take harmful text out of a room: it
// removes the text and records the withdrawal on the receipt.
function findEditableMessage(state, incoming, { evidence = "refuse" } = {}) {
  const message = state.messages.find(m => m.id === incoming.data.messageId);
  if (!message) throw new Error("Message not found");
  if (message.deletedAt) throw new Error("Message was deleted");
  const evidenceFor = evidence === "refuse" ? evidenceReceipt(state, message.id) : null;
  if (evidenceFor) throw new Error(`This message is the recorded result of ${evidenceFor.id} and cannot be changed`);
  const actor = requireMember(state, incoming.actorId);
  if (message.authorId !== actor.id && actor.id !== state.room.ownerId) throw new Error("Only the author or the Room owner can change this message");
  if ((message.revision ?? 0) !== incoming.data.expectedMessageRevision) throw new Error("Message changed; refresh before editing");
  return { message, actor };
}

function editMessage(state, incoming) {
  const { message } = findEditableMessage(state, incoming);
  if (typeof incoming.data.body !== "string" || !incoming.data.body.trim()) throw new Error("Message body must be text");
  message.editHistory = [...(message.editHistory ?? []), { body: message.body, editedAt: incoming.at }];
  message.body = incoming.data.body;
  message.revision = (message.revision ?? 0) + 1;
  message.editedAt = incoming.at;
}

function deleteMessage(state, incoming) {
  const { message } = findEditableMessage(state, incoming, { evidence: "withdraw" });
  message.body = null;
  // Deletion hides every earlier version too; the tombstone keeps only who/when.
  message.editHistory = [];
  message.deletedAt = incoming.at;
  message.deletedBy = incoming.actorId;
  dropPinsForMessage(state, message.id); // issue #6 B2: the tombstone drops the pin too
  withdrawTextEvidence(state, message.id, incoming);
  message.revision = (message.revision ?? 0) + 1;
}

function setMessageReaction(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["messageId", "reaction", "active"]);
  const { messageId, reaction, active } = incoming.data;
  const message = state.messages.find(m => m.id === messageId);
  if (!message) throw new Error("Reaction must reference a message in this Room");
  const key = canonicalReaction(reaction);
  if (!key || typeof active !== "boolean") throw new Error("Invalid reaction choice");
  // Replay and checkpoints may still carry like/heart/celebrate/thinking.
  // Fold those into the Unicode key before applying this choice.
  message.reactions = foldedReactionMap(message.reactions);
  const members = new Set(message.reactions[key] || []);
  if (active) {
    if (!message.reactions[key] && Object.keys(message.reactions).length >= MAX_REACTIONS_PER_MESSAGE) {
      throw new Error("Too many reactions on this message");
    }
    members.add(actor.id);
  } else members.delete(actor.id);
  if (members.size) message.reactions[key] = [...members].sort();
  else delete message.reactions[key];
}

function proposeWork(state, incoming) {
  requirePermission(state, incoming.actorId, "steer");
  requireFields(incoming.data, ["workItemId", "title", "definitionOfDone", "accountableMemberId"]);
  if (state.workItems[incoming.data.workItemId]) throw new Error("Work Item already exists");
  requireMember(state, incoming.data.accountableMemberId);
  // Trust off refuses a cross-owner assign before the item is recorded.
  // Same-owner assigns, including an owner handing work to their own agent,
  // are unchanged. Replay applies the Trust value in force at this point
  // in the log, so an earlier assign stays valid after a later flip.
  assertRoomTrust(state, incoming.actorId, incoming.data.accountableMemberId);
  if (incoming.data.mode && !["read", "write"].includes(incoming.data.mode)) throw new Error("Invalid work mode");
  // RC-2026-09-23: optional machine-readable labels (e.g. "friction" for
  // friction reports from agent feedback). Validated as an array of short
  // slugs; stored on the projection for filtering and digests. The field is
  // omitted entirely when the event lacks it, so pre-label legacy rows replay
  // to a projection without the key (recovery audit byte-compatibility).
  let labels;
  if (incoming.data.labels !== undefined) {
    if (!Array.isArray(incoming.data.labels) || incoming.data.labels.length > 10
      || incoming.data.labels.some(l => typeof l !== "string" || !/^[a-z0-9-]{1,32}$/.test(l)))
      throw new Error("labels must be an array of up to 10 slugs ([a-z0-9-], max 32 chars)");
    labels = [...incoming.data.labels];
  }
  // Room policy overrides the proposer's choice: altered client fields cannot
  // disable a mandatory gate. The recorded event keeps what the client sent;
  // the projection (and every replay) applies the policy in force at this point
  // of the log, so earlier items are untouched by a later flip.
  const policy = roomPolicy(state);
  const independentVerificationRequired = policy.requireIndependentReview || incoming.data.independentVerificationRequired === true;
  const ownerDecisionRequired = policy.requireOwnerDecision || incoming.data.ownerDecisionRequired === true;
  const humanDecisionMakerId = incoming.data.humanDecisionMakerId || (policy.requireOwnerDecision ? state.room.ownerId : null);
  if (independentVerificationRequired && !incoming.data.verifierMemberId) {
    throw new Error(policy.requireIndependentReview ? "Room policy requires independent review: name a verifier" : "Independent work requires a verifier");
  }
  if (ownerDecisionRequired && !humanDecisionMakerId) throw new Error("Owner decision requires a decision-maker");
  if (incoming.data.verifierMemberId) requireMember(state, incoming.data.verifierMemberId);
  if (humanDecisionMakerId) {
    const decisionMaker = requireMember(state, humanDecisionMakerId);
    if (decisionMaker.kind !== "human") throw new Error("Decision-maker must be a human member");
  }
  if (independentVerificationRequired && incoming.data.accountableMemberId === incoming.data.verifierMemberId) {
    throw new Error("Independent verification requires a different accountable member and verifier");
  }
  if (incoming.data.sourceMessageId && !state.messages.some((message) => message.id === incoming.data.sourceMessageId)) {
    throw new Error("Source message must exist in this Room");
  }

  state.workItems[incoming.data.workItemId] = {
    id: incoming.data.workItemId,
    title: incoming.data.title,
    definitionOfDone: incoming.data.definitionOfDone,
    accountableMemberId: incoming.data.accountableMemberId,
    verifierMemberId: incoming.data.verifierMemberId || null,
    independentVerificationRequired,
    ownerDecisionRequired,
    humanDecisionMakerId,
    mode: incoming.data.mode || "read",
    sourceMessageId: incoming.data.sourceMessageId || null,
    ...(labels !== undefined ? { labels } : {}),
    // The proposer is the envelope actor alone (disposition 5557850637): replay recovers it
    // wherever the envelope exists; it is never read from data and never inferred from the
    // source message's author. Pre-field legacy rows simply lack the key and render unknown.
    proposedById: incoming.actorId,
    state: WORK_STATES.PROPOSED,
    revision: 0,
    claim: null,
    receipt: null,
    receiptHistory: [],
    verification: null,
    verificationHistory: [],
    decision: null,
    decisionHistory: [],
    blocker: null,
    supersededBy: null,
    createdAt: incoming.at,
    updatedAt: incoming.at
  };
}

function acceptWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.PROPOSED]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may accept work");
  requirePermission(state, incoming.actorId, "accept_work");
  item.state = WORK_STATES.ACCEPTED;
  commitMutation(item, incoming);
}

function startWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.BLOCKED]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may start work");
  requirePermission(state, incoming.actorId, "accept_work");
  if (item.mode === "write") requirePermission(state, incoming.actorId, "write_external");
  if (item.state === WORK_STATES.BLOCKED) requireFields(incoming.data, ["resolvedBlocker"]);
  if (item.mode === "write" && (!item.claim || !claimIsActive(item.claim, incoming.at) || item.claim.holderId !== incoming.actorId)) {
    throw new Error("Contested writes require a current exact-scope claim");
  }
  if (item.state === WORK_STATES.BLOCKED) archiveDecision(item);
  item.state = WORK_STATES.WORKING;
  item.blocker = null;
  if (item.handoff) item.handoff.open = false;
  commitMutation(item, incoming);
}

function blockWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.COMPLETED]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may block work; verifier findings use verification.recorded");
  requirePermission(state, incoming.actorId, "accept_work");
  requireFields(incoming.data, ["reason", "nextAction"]);
  if (item.state === WORK_STATES.COMPLETED) retireApproval(item, incoming, "rework");
  item.state = WORK_STATES.BLOCKED;
  item.blocker = { reason: incoming.data.reason, nextAction: incoming.data.nextAction, eventId: incoming.id };
  if (item.handoff) item.handoff.open = false;
  commitMutation(item, incoming);
}


// Capability registry: members advertise what they can do so other agents can
// discover and delegate. Self-advertised only; replaces the previous list.
function advertiseCapabilities(state, incoming) {
  const member = requireMember(state, incoming.actorId);
  if (member.active === false) throw new Error("Inactive members cannot advertise capabilities");
  const caps = incoming.data.capabilities;
  if (!Array.isArray(caps) || caps.length === 0 || caps.length > 30) {
    throw new Error("Capabilities must be a list of 1 to 30 entries");
  }
  const clean = [];
  for (const cap of caps) {
    if (typeof cap !== "string" || !cap.trim() || cap.length > 80) {
      throw new Error("Each capability must be 1 to 80 characters");
    }
    const trimmed = cap.trim();
    if (!clean.includes(trimmed)) clean.push(trimmed);
  }
  member.capabilities = clean;
  // Advertising capabilities is self-description, not an authority change, so it
  // leaves member.revision alone (open help invitations/offers are pinned to it).
  member.updatedAt = incoming.at;
}

// RC-2026-09-19-071 (QAJ-006): an access request arrived. Validates the
// envelope and records nothing in the projection — the access_requests table
// is the source of truth and decisions never touch the projection, so a
// stored copy would go stale. The event still lands in state.eventLog (done
// by applyEvent itself), which is what the timeline renders and the
// notification feed derives from.
function recordAccessRequest(state, incoming) {
  requireFields(incoming.data, ["requestId", "identityId", "displayName"]);
  // The ask, not the grant: the owner chooses the final permissions at
  // decision time. An empty list requests basic read/chat membership.
  const permissions = incoming.data.permissions;
  if (!Array.isArray(permissions)) {
    throw new Error("Event data missing permissions");
  }
}

// Referral attribution audit record. The referrals table is the queryable
// source of truth; this event is the timeline-visible proof that a join was
// attributed. Validates the envelope and records nothing in the projection.
// Bond receipts mirror the agent_bonds row onto the room projection for the
// room where the command was issued. They do not grant membership, and
// dm.posted does not enter state.messages (that array is room chat).
function recordBond(state, incoming) {
  requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["bondId", "agentAId", "agentBId"]);
  state.bonds ??= {};
  const id = incoming.data.bondId;
  const prior = state.bonds[id] ?? {};
  if (incoming.type === EVENT_TYPES.BOND_PROPOSED) {
    requireFields(incoming.data, ["proposerIdentityId", "scopes"]);
    state.bonds[id] = {
      id,
      agentAId: incoming.data.agentAId,
      agentBId: incoming.data.agentBId,
      state: "proposed",
      proposedById: incoming.data.proposerIdentityId,
      proposedScopes: incoming.data.scopes,
      acceptedScopes: [],
      note: incoming.data.note ?? null,
      proposedAt: incoming.at,
      acceptedAt: null,
      revokedAt: null,
      revokedById: null
    };
    return;
  }
  if (incoming.type === EVENT_TYPES.BOND_ACTIVATED) {
    requireFields(incoming.data, ["acceptedScopes", "proposerIdentityId"]);
    state.bonds[id] = {
      ...prior,
      id,
      agentAId: incoming.data.agentAId,
      agentBId: incoming.data.agentBId,
      state: "active",
      proposedById: incoming.data.proposerIdentityId,
      acceptedScopes: incoming.data.acceptedScopes,
      acceptedAt: incoming.at,
      revokedAt: null,
      revokedById: null
    };
    return;
  }
  requireFields(incoming.data, ["revokedById", "reason"]);
  state.bonds[id] = {
    ...prior,
    id,
    agentAId: incoming.data.agentAId,
    agentBId: incoming.data.agentBId,
    state: "revoked",
    revokedAt: incoming.at,
    revokedById: incoming.data.revokedById,
    reason: incoming.data.reason
  };
}

function recordPeerDm(state, incoming) {
  requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["messageId", "threadId", "bondId", "body", "fromIdentityId", "toIdentityId"]);
  if (incoming.data.fromIdentityId === incoming.data.toIdentityId) throw new Error("Cannot DM yourself");
  // Receipt only. Peer DM bodies stay out of room chat (state.messages).
}

// Land-queue wake receipt. The land_queue table is the source of truth, so
// this records nothing on the projection. It validates the thin payload the
// claimant is woken with: pr, head, state, and what changed.
function recordLandUpdate(state, incoming) {
  requireMember(state, incoming.actorId);
  const data = incoming.data ?? {};
  if (typeof data.itemId !== "string" || !validId(data.itemId)) throw new Error("Event data missing itemId");
  if (typeof data.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(data.repo)) throw new Error("Event data missing repo");
  if (!Number.isSafeInteger(data.pr) || data.pr < 1) throw new Error("Event data missing pr");
  if (!(data.head === null || (typeof data.head === "string" && /^[0-9a-f]{40}$/.test(data.head)))) throw new Error("Event data missing head");
  const stateFields = data.state;
  if (!stateFields || typeof stateFields !== "object") throw new Error("Event data missing state");
  if (!["pending", "green", "red"].includes(stateFields.checks)) throw new Error("Event data missing state");
  if (typeof stateFields.behind !== "boolean") throw new Error("Event data missing state");
  if (!["mergeable", "behind", "conflict", "unknown", "merged"].includes(stateFields.mergeable)) throw new Error("Event data missing state");
  if (typeof stateFields.merged !== "boolean") throw new Error("Event data missing state");
  if (!Array.isArray(data.changed) || data.changed.length === 0
    || data.changed.some(change => !["green", "red", "behind", "merged", "tip"].includes(change))) {
    throw new Error("Event data missing changed");
  }
}

function recordReferral(state, incoming) {
  requireFields(incoming.data, ["referrerMemberId", "refereeMemberId", "via", "completedAt"]);
  const { referrerMemberId, refereeMemberId, via } = incoming.data;
  for (const id of [referrerMemberId, refereeMemberId]) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error("referral member ids must be valid");
  }
  if (referrerMemberId === refereeMemberId) throw new Error("a member cannot refer themselves");
  if (!["invite", "request"].includes(via)) throw new Error("referral via must be invite or request");
  if (!Number.isInteger(incoming.data.completedAt)) throw new Error("referral completedAt must be an integer timestamp");
  // Both sides must be members at journal time; the referee was just added.
  requireMember(state, referrerMemberId);
  requireMember(state, refereeMemberId);
}

function recordHandoff(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may record a handoff");
  requirePermission(state, incoming.actorId, "accept_work");
  requireFields(incoming.data, ["doneSummary", "nextAction", "limitReason"]);
  if (incoming.data.evidenceUrl !== undefined || incoming.data.evidenceVersion !== undefined) {
    requireFields(incoming.data, ["evidenceUrl", "evidenceVersion"]);
    try {
      const url = new URL(incoming.data.evidenceUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch { throw new Error("Evidence must be an HTTPS URL without credentials"); }
  }
  // A handoff never advances or closes the state; review and decision gates stay untouched.
  if (item.handoff) {
    item.handoffHistory = item.handoffHistory || [];
    item.handoffHistory.push(item.handoff);
    if (item.handoffHistory.length > 20) item.handoffHistory.shift();
  }
  item.handoff = {
    open: true, eventId: incoming.id, at: incoming.at, actorId: incoming.actorId,
    // An open handoff is triage work addressed to the Room owner, so needs-me
    // views and attention inboxes can surface it to a named member.
    triageMemberId: state.room.ownerId,
    doneSummary: incoming.data.doneSummary,
    evidenceUrl: incoming.data.evidenceUrl ?? null, evidenceVersion: incoming.data.evidenceVersion ?? null,
    nextAction: incoming.data.nextAction, limitReason: incoming.data.limitReason,
    haltAll: incoming.data.haltAll === true
  };
  if (incoming.data.haltAll === true) {
    state.agentHalts = state.agentHalts || {};
    state.agentHalts[incoming.actorId] = { eventId: incoming.id, at: incoming.at, reason: incoming.data.limitReason, workItemId: item.id };
  }
  commitMutation(item, incoming);
}

function clearHalt(state, incoming) {
  requireMember(state, incoming.actorId);
  const permissions = state.members[incoming.actorId]?.permissions || [];
  if (!permissions.includes("steer") && !permissions.includes("decide")) throw new Error("Clearing a halt requires steer or decide");
  requireFields(incoming.data, ["memberId", "haltEventId"]);
  const halt = state.agentHalts?.[incoming.data.memberId];
  if (!halt || halt.eventId !== incoming.data.haltEventId) throw new Error("Stale or unknown halt");
  delete state.agentHalts[incoming.data.memberId];
}

function resolveBlocker(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.BLOCKED]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may resolve the blocker");
  requirePermission(state, incoming.actorId, "accept_work");
  requireFields(incoming.data, ["resolution"]);
  archiveDecision(item);
  item.state = WORK_STATES.ACCEPTED;
  item.blocker = null;
  if (item.handoff) item.handoff.open = false;
  commitMutation(item, incoming);
}

function completeWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may report completion");
  requirePermission(state, incoming.actorId, "complete_work");
  if (item.mode === "write") {
    requirePermission(state, incoming.actorId, "write_external");
    if (!item.claim || !claimIsActive(item.claim, incoming.at) || item.claim.holderId !== incoming.actorId) throw new Error("Completion requires a current exact-scope claim");
  }
  let nativeText = null, signedEvidence = null;
  if (incoming.data.evidenceKind === "room_text") {
    requireFields(incoming.data, ["summary", "evidenceVersion", "nextAction"]);
    nativeText = nativeTextEvidence(state, item, incoming.data);
  }
  else {
    if (["evidenceKind", "evidenceMessageId", "evidenceMessageEventId", "previousCompletionEventId"].some(key => Object.hasOwn(incoming.data, key))) throw new Error("Choose one evidence format");
    // Integration map slice 5: external evidence is a signed object
    // (room-signed-evidence/1). The live command path rejects an external
    // completion whose evidence does not verify against the agent key
    // registry; the applier only records it. The freeform evidenceUrl /
    // evidenceVersion pair stays for display but authenticates nothing.
    requireFields(incoming.data, ["summary", "nextAction"]);
    signedEvidence = incoming.data.signedEvidence ?? null;
    if (incoming.data.evidenceUrl !== undefined && incoming.data.evidenceUrl !== null) {
      try {
        const url = new URL(incoming.data.evidenceUrl);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      } catch { throw new Error("Evidence must be an HTTPS URL without credentials"); }
    }
  }
  const attribution = reportedProducer(incoming.data), { producerId } = attribution;
  if (producerId !== null) knownMember(state, producerId);
  if (item.receipt) item.receiptHistory.push(item.receipt);
  if (item.verification) item.verificationHistory.push(item.verification);
  if (item.decision) item.decisionHistory.push(item.decision);
  item.receipt = {
    // The authenticated envelope actor reports completion. Producer attribution is a
    // separate, nullable assertion: omission is explicitly unknown, never guessed from
    // the reporter. This also lets verification enforce independence when a producer is
    // actually known.
    reportedById: incoming.actorId,
    ...attribution,
    summary: incoming.data.summary,
    evidenceUrl: nativeText ? null : (incoming.data.evidenceUrl ?? null),
    ...(nativeText ? { nativeText } : {}),
    // Slice 5: the verified signed evidence rides the receipt so readers
    // can check the signature without fetching any URL.
    ...(!nativeText && signedEvidence !== null ? { signedEvidence } : {}),
    evidenceVersion: incoming.data.evidenceVersion ?? null,
    checksClaimed: incoming.data.checksClaimed || [],
    // RC-2026-09-19-063: optional fact/inference/proposal marks, validated on
    // the way in. Unmarked completions replay exactly as before — the field
    // is present but null, never guessed.
    segments: validateResultSegments(incoming.data.segments),
    nextAction: incoming.data.nextAction,
    eventId: incoming.id
  };
  item.verification = null;
  item.decision = null;
  item.blocker = null;
  item.state = WORK_STATES.COMPLETED;
  if (item.handoff) item.handoff.open = false;
  commitMutation(item, incoming);
}

function supersedeWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.PROPOSED, WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED, WORK_STATES.COMPLETED]);
  requirePermission(state, incoming.actorId, "steer");
  requireFields(incoming.data, ["supersededByWorkItemId", "reason"]);
  const replacement = requireWorkItem(state, incoming.data.supersededByWorkItemId);
  if (replacement.id === item.id) throw new Error("A Work Item cannot supersede itself");
  if (replacement.state === WORK_STATES.SUPERSEDED || replacement.supersededBy) throw new Error("Replacement Work Item must not already be superseded");
  if (item.claim && claimIsActive(item.claim, incoming.at)) {
    item.claim.status = "superseded";
    item.claim.supersededAt = incoming.at;
  }
  retireApproval(item, incoming, "superseded");
  item.state = WORK_STATES.SUPERSEDED;
  item.supersededBy = incoming.data.supersededByWorkItemId;
  if (item.handoff) item.handoff.open = false;
  commitMutation(item, incoming);
}

function acquireClaim(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED]);
  if (item.mode !== "write") throw new Error("Read-only work does not use a write claim");
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may acquire this claim");
  requirePermission(state, incoming.actorId, "write_external");
  requireFields(incoming.data, ["repository", "ref", "paths", "expiresAt"]);
  if (!Array.isArray(incoming.data.paths) || incoming.data.paths.length === 0) throw new Error("Claim paths must be explicit");
  if (!Number.isFinite(Date.parse(incoming.data.expiresAt)) || Date.parse(incoming.data.expiresAt) <= Date.parse(incoming.at)) throw new Error("Claim expiry must be in the future");
  if (item.claim && claimIsActive(item.claim, incoming.at)) throw new Error("A current claim already exists");
  item.claim = {
    holderId: incoming.actorId,
    repository: incoming.data.repository,
    ref: incoming.data.ref,
    paths: [...incoming.data.paths],
    acquiredAt: incoming.at,
    expiresAt: incoming.data.expiresAt,
    status: "active"
  };
  commitMutation(item, incoming);
}

function releaseClaim(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED, WORK_STATES.COMPLETED]);
  if (!item.claim || !claimIsActive(item.claim, incoming.at)) throw new Error("No current claim to release");
  if (incoming.actorId !== item.claim.holderId && !hasPermission(state, incoming.actorId, "manage_claims")) {
    throw new Error("Only the holder or claim manager may release a claim");
  }
  item.claim.status = "released";
  item.claim.releasedAt = incoming.at;
  commitMutation(item, incoming);
}

// Lease-renewal check-ins: a claim's lease is extended only when the holder
// posts a public progress update in the room after the current lease window
// began. Renewals are discussed in the channel — never silent extensions —
// so a stale holder can't hold scope indefinitely without showing work.
function renewClaim(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED]);
  if (!item.claim || !claimIsActive(item.claim, incoming.at)) throw new Error("No active claim to renew — acquire a fresh claim instead");
  if (incoming.actorId !== item.claim.holderId) throw new Error("Only the claim holder may renew this claim");
  requireFields(incoming.data, ["progressMessageId", "expiresAt"]);
  if (!Number.isFinite(Date.parse(incoming.data.expiresAt)) || Date.parse(incoming.data.expiresAt) <= Date.parse(incoming.at)) throw new Error("Claim expiry must be in the future");
  requireProgressCheckin(state, item.claim, incoming.actorId, incoming.data.progressMessageId);
  item.claim.expiresAt = incoming.data.expiresAt;
  item.claim.renewedAt = incoming.at;
  item.claim.renewals = (item.claim.renewals ?? 0) + 1;
  item.claim.progressMessageId = incoming.data.progressMessageId;
  commitMutation(item, incoming);
}

// The cited progress check-in must be a live public message in this room,
// authored by the claim holder, and newer than the current lease window's
// start (the acquisition, or the previous renewal). The same room's
// projection is the lookup, so a cross-room id never resolves, and a DM
// (toMemberId) can never serve as the public check-in.
function requireProgressCheckin(state, claim, holderId, progressMessageId) {
  const message = state.messages.find(m => m.id === progressMessageId);
  if (!message || message.deletedAt) {
    throw new Error("Renewal needs a progress message in this room — post a progress update in the room first");
  }
  if (message.toMemberId) {
    throw new Error("Renewal needs a public progress message — post the update in the room, not as a DM");
  }
  if (message.authorId !== holderId) {
    throw new Error("Renewal needs the claim holder's own progress message");
  }
  const leaseStart = claim.renewedAt ?? claim.acquiredAt;
  if (!(Date.parse(message.createdAt) > Date.parse(leaseStart))) {
    throw new Error("Renewal needs a progress message newer than the current lease start");
  }
}

function recordVerification(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.COMPLETED, WORK_STATES.BLOCKED]);
  if (incoming.actorId !== item.verifierMemberId) throw new Error("Only the designated verifier may verify");
  requirePermission(state, incoming.actorId, "verify");
  if (item.independentVerificationRequired && incoming.actorId === item.accountableMemberId) {
    throw new Error("Independent verification requires a different actor");
  }
  requireFields(incoming.data, ["result", "completionEventId", "evidenceVersion", "summary"]);
  const matchesCurrentReceipt = matchesReceipt(incoming.data, item.receipt);
  const matchedReceipt = matchesCurrentReceipt ? item.receipt
    : item.receiptHistory.find(receipt => matchesReceipt(incoming.data, receipt));
  if (!matchedReceipt) {
    throw new Error("Verification must identify the exact current completion and evidence version");
  }
  const producerKnown = receiptHasKnownProducer(matchedReceipt);
  if (item.independentVerificationRequired && producerKnown && matchedReceipt.producerId === incoming.actorId) {
    throw new Error("Independent verification requires a verifier different from the known producer");
  }
  if (!["pass", "fail"].includes(incoming.data.result)) throw new Error("Verification result must be pass or fail");

  const verification = {
    verifierId: incoming.actorId,
    result: incoming.data.result,
    completionEventId: incoming.data.completionEventId,
    evidenceVersion: incoming.data.evidenceVersion,
    summary: incoming.data.summary,
    // A useful exact-version check may still be recorded when the producer is unknown,
    // but only an explicitly attributed, different producer establishes independence.
    independenceConfirmed: producerKnown && matchedReceipt.producerId !== incoming.actorId,
    eventId: incoming.id
  };

  if (!matchesCurrentReceipt) {
    item.verificationHistory.push({ ...verification, historical: true });
    commitMutation(item, incoming);
    return;
  }

  if (item.verification) item.verificationHistory.push(item.verification);
  item.verification = verification;
  if (incoming.data.result === "fail") {
    retireApproval(item, incoming, "verification_failed");
    item.state = WORK_STATES.BLOCKED;
    item.blocker = {
      reason: incoming.data.summary,
      nextAction: incoming.data.nextAction || "Accountable member addresses the finding",
      eventId: incoming.id
    };
  }
  commitMutation(item, incoming);
}

function applySession(state, incoming) {
  const item = mutableWorkItem(state, incoming, [
    WORK_STATES.PROPOSED, WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED, WORK_STATES.COMPLETED
  ]);
  const actor = requireMember(state, incoming.actorId);
  const accountable = actor.id === item.accountableMemberId && hasPermission(state, actor.id, "accept_work");
  if (!accountable && !hasPermission(state, actor.id, "steer")) {
    throw new Error("Only the accountable member or a steerer may change this session");
  }
  applySessionFields(item, incoming);
  commitMutation(item, incoming);
}


// Decision register (backlog F2): promoting a conversation point into policy is
// an explicit, source-backed act. The reducer only validates - the event itself
// is the record, so replay and the work-item projection are untouched. A
// suggestion stays a suggestion until a human with the decide permission
// records it against an exact message.
function recordDecision(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requirePermission(state, incoming.actorId, "decide");
  if (actor.kind !== "human") throw new Error("Only a human member may record a decision");
  requireFields(incoming.data, ["sourceMessageId", "statement"]);
  if (!state.messages.some(m => m.id === incoming.data.sourceMessageId)) {
    throw new Error("Decision must reference a message in this Room");
  }
  const statement = String(incoming.data.statement);
  if (statement !== statement.trim() || statement.length > 500) {
    throw new Error("Decision statement must be trimmed text up to 500 characters");
  }
  if (incoming.data.note !== undefined && incoming.data.note !== null
    && (typeof incoming.data.note !== "string" || incoming.data.note !== incoming.data.note.trim() || incoming.data.note.length > 500)) {
    throw new Error("Decision note must be trimmed text up to 500 characters");
  }
}

function recordOwnerDecision(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.COMPLETED]);
  const actor = requireMember(state, incoming.actorId);
  requirePermission(state, incoming.actorId, "decide");
  if (actor.kind !== "human" || actor.id !== item.humanDecisionMakerId) {
    throw new Error("Only the designated human decision-maker may decide");
  }
  requireFields(incoming.data, ["decision", "completionEventId", "evidenceVersion", "reason"]);
  if (!["approved", "changes_requested", "rejected"].includes(incoming.data.decision)) {
    throw new Error("Unsupported owner decision");
  }
  if (!matchesReceipt(incoming.data, item.receipt)) {
    throw new Error("Decision must identify the exact current completion and evidence version");
  }
  if (incoming.data.decision === "approved" && item.independentVerificationRequired && !hasConfirmedIndependentPass(item)) {
    throw new Error("Approval requires the designated independent PASS with confirmed producer independence");
  }

  if (item.decision) item.decisionHistory.push(item.decision);
  item.decision = {
    actorId: actor.id,
    decision: incoming.data.decision,
    completionEventId: incoming.data.completionEventId,
    evidenceVersion: incoming.data.evidenceVersion,
    reason: incoming.data.reason,
    eventId: incoming.id
  };
  // F2: a decision must cite the public room message carrying its rationale —
  // decisions get discussed in the channel, not handed down. Events recorded
  // before the requirement carry no sourceMessageId and must still replay, so
  // the reducer only validates a source when one is present; every new
  // command is required to include one (see validateCommand).
  if (incoming.data.sourceMessageId != null) {
    requirePublicDecisionSource(state, incoming.data.sourceMessageId);
    item.decision.sourceMessageId = incoming.data.sourceMessageId;
  }
  if (incoming.data.decision !== "approved") {
    item.state = WORK_STATES.BLOCKED;
    item.blocker = {
      reason: incoming.data.reason,
      nextAction: "Accountable member accepts a revised direction before another attempt",
      eventId: incoming.id
    };
  }
  commitMutation(item, incoming);
}

function mutableWorkItem(state, incoming, allowedStates) {
  requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["workItemId"]);
  const item = requireWorkItem(state, incoming.data.workItemId);
  if (!allowedStates.includes(item.state)) throw new Error(`Invalid transition from ${item.state}`);
  // Optional compare-and-swap. Absent means last-writer-wins. Present and
  // stale is still a conflict.
  if (incoming.data.expectedRevision != null && incoming.data.expectedRevision !== item.revision)
    throw new Error(`Stale Work Item revision: expected ${item.revision}`);
  return item;
}

function commitMutation(item, incoming) {
  item.revision += 1;
  item.updatedAt = incoming.at;
}

function archiveDecision(item) {
  if (item.decision) item.decisionHistory.push(item.decision);
  item.decision = null;
}

function retireApproval(item, incoming, reason) {
  if (item.decision?.decision !== "approved") return;
  item.decisionHistory.push({ ...item.decision, historical: true, invalidatedByEventId: incoming.id, invalidatedReason: reason });
  item.decision = null;
}

function claimIsActive(claim, at) {
  return claim.status === "active" && Date.parse(claim.expiresAt) > Date.parse(at);
}

export function receiptHasKnownProducer(receipt) {
  return receipt?.producerAttribution === "reported" && receipt.producerId != null;
}

export function matchesReceipt(record, receipt) {
  return Boolean(record && receipt?.eventId && receipt?.evidenceVersion
    && record.completionEventId === receipt.eventId && record.evidenceVersion === receipt.evidenceVersion);
}

export function hasConfirmedIndependentPass(item) {
  const { receipt, verification } = item;
  return verification?.result === "pass" &&
    verification.independenceConfirmed === true &&
    verification.verifierId === item.verifierMemberId &&
    matchesReceipt(verification, receipt) &&
    receiptHasKnownProducer(receipt) &&
    receipt.producerId !== verification.verifierId;
}

function requireMember(state, memberId) {
  const member = knownMember(state, memberId);
  if (member.active === false) throw new Error("Member access revoked");
  return member;
}

function knownMember(state, memberId) {
  const member = Object.hasOwn(state.members, memberId) && state.members[memberId];
  if (!member) throw new Error(`Unknown member: ${memberId}`);
  return member;
}

// F2: the cited source must be a live public message in this room — the same
// room's projection is the lookup, so a cross-room id never resolves, and a
// DM (toMemberId) can never serve as the public rationale.
function requirePublicDecisionSource(state, sourceMessageId) {
  const message = state.messages.find(m => m.id === sourceMessageId);
  if (!message || message.deletedAt) {
    throw new Error("Decision source must be a message in this Room — post the rationale in the room first");
  }
  if (message.toMemberId) {
    throw new Error("Decision source must be a public room message — post the rationale in the room first");
  }
}

function requireWorkItem(state, workItemId) {
  const item = Object.hasOwn(state.workItems, workItemId) && state.workItems[workItemId];
  if (!item) throw new Error(`Unknown Work Item: ${workItemId}`);
  return item;
}

function requirePermission(state, memberId, permission) {
  if (!hasPermission(state, memberId, permission)) throw new Error(`${memberId} lacks ${permission}`);
}

export function memberCan(state, memberId, permission) {
  return hasPermission(state, memberId, permission);
}

function hasPermission(state, memberId, permission) {
  return requireMember(state, memberId).permissions.includes(permission);
}

function requireFields(data, fields) {
  for (const field of fields) {
    if (data?.[field] === undefined || data?.[field] === null || (typeof data[field] === "string" && !data[field].trim())) {
      throw new Error(`Event data missing ${field}`);
    }
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Pinned messages (issue #6 B2). A pin is a room-visible bookmark on one
// existing message: any active member can pin or unpin, the room keeps at most
// PIN_LIMIT pins, and the pinned list is ordered by when each pin was placed.
// Pins reference message ids only; a deleted message (tombstone) drops out of
// the pinned list under the same rules that hide its body everywhere else
// (deleteMessage calls dropPinsForMessage). Event-sourced: message.pinned /
// message.unpinned append to the room log and the projection carries
// state.pins = [{ messageId, pinnedById, pinnedAt }]. Both reducers are
// idempotent so an exact retry, or a replay of a duplicate, changes nothing.
// The HTTP surface lives in server/pins.mjs.
export const PIN_LIMIT = 50;

// Command field allowlist for server/store.mjs validateCommand.
export const PIN_COMMAND_SHAPES = Object.freeze({
  [EVENT_TYPES.MESSAGE_PINNED]: "messageId",
  [EVENT_TYPES.MESSAGE_UNPINNED]: "messageId"
});

function pinTarget(incoming) {
  const messageId = incoming.data?.messageId;
  if (typeof messageId !== "string" || !messageId.trim()) throw new Error("Missing required field: messageId");
  return messageId;
}

function pinMessage(state, incoming) {
  requireMember(state, incoming.actorId);
  const messageId = pinTarget(incoming);
  const message = state.messages.find(m => m.id === messageId);
  if (!message) throw new Error("Pin must reference a message in this Room");
  if (message.deletedAt || message.body == null) throw new Error("A deleted message cannot be pinned");
  state.pins ??= [];
  if (state.pins.some(pin => pin.messageId === messageId)) return; // idempotent
  if (state.pins.length >= PIN_LIMIT) throw new Error(`Pin capacity reached: ${PIN_LIMIT} pinned messages per room; unpin one first`);
  state.pins.push({ messageId, pinnedById: incoming.actorId, pinnedAt: incoming.at });
}

function unpinMessage(state, incoming) {
  requireMember(state, incoming.actorId);
  const messageId = pinTarget(incoming);
  if (!state.pins?.length) return; // idempotent
  state.pins = state.pins.filter(pin => pin.messageId !== messageId);
}

function dropPinsForMessage(state, messageId) {
  if (state.pins?.some(pin => pin.messageId === messageId)) state.pins = state.pins.filter(pin => pin.messageId !== messageId);
}

export function isPinned(state, messageId) {
  return Boolean(state?.pins?.some(pin => pin.messageId === messageId));
}

// Ordered pinned list joined with the live message. Tombstoned or missing
// messages are filtered defensively even though the reducer already drops them.
export function pinnedMessages(state) {
  const byId = new Map((state?.messages ?? []).map(message => [message.id, message]));
  return (state?.pins ?? []).flatMap(pin => {
    const message = byId.get(pin.messageId);
    return message && !message.deletedAt && message.body != null ? [{ ...pin, message }] : [];
  });
}
