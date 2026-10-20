import { createWorkReducers } from "./work-reducers.js";
import { createMessageReducers, isRedactedBody } from "./message-reducers.js";
import { assertMemberDisplayNameAvailable } from "./display-name-guard.js";
import { proposalContext } from "./work-packet.js";
import { CHARTER_TYPE, charterFromEvent } from "./room-charter.js";
import { REPLY_CANCELLED, cancelReplyRequest } from "./reply-requests.js";
import { WORK_HELP_UPDATED, helpFromEvent } from "./work-help.js";
import { HELP_OFFER_OPENED, HELP_OFFER_UPDATED, helpOfferFromEvent } from "./help-offers.js";
import { SESSION_EVENT_TYPES, ensureWorkControlDefaults } from "./work-item-session.js";

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
  // Owner kill-switch for the priced-tool gate. Default enabled when absent.
  ROOM_SPEND_PRICING_SET: "room.spend_pricing_set",
  // One owner kill-switch for cross-owner assign and wake. Default open.
  ROOM_TRUST_SET: "room.trust_set",
  // Owner opt-in for the public receipts page. Default off when absent.
  ROOM_PUBLIC_RECEIPTS_SET: "room.public_receipts_set",
  // --- GR2 public acquisition opt-ins. Absent means off. ---
  ROOM_PUBLIC_PAGE_SET: "room.public_page_set",
  ROOM_JOIN_LINK_SET: "room.join_link_set",
  MEMBER_PUBLIC_NAME_SET: "member.public_name_set",
  WORK_PUBLIC_SET: "work.public_set",
  // --- end GR2 ---
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
  // --- PRIV-1 message redaction ---
  MESSAGE_REDACTED: "message.redacted",
  RECEIPT_EVIDENCE_WITHDRAWN: "receipt.evidence_withdrawn",
  // --- PRIV-2 history visibility and export authority ---
  ROOM_HISTORY_VISIBILITY_SET: "room.history_visibility_set",
  ROOM_EXPORTED: "room.exported",
  // --- end PRIV-2 ---
  // --- end PRIV-1 message redaction ---
  REPLY_REQUEST_CANCELLED: REPLY_CANCELLED,
  POLL_VOTED: "poll.voted",
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
  // DM-consent receipt. The consent state lives in the dm_consents side
  // table (server/dm-consents.mjs); this event is the thin sequenced record
  // so a pair member's open session refreshes live. server/dm-consents.mjs
  // appends it; server/dm-event-visibility.mjs hides it from non-parties.
  DM_CONSENT_CHANGED: "dm.consent_changed",
  // Land queue receipt. The land_queue table is the source of truth; this
  // event is the thin wake record (pr, head, state, what changed).
  LAND_UPDATED: "land.updated",
  // Work-claim receipt. The work_claims table is the source of truth; this
  // event is the thin room record of who claimed, renewed, handed off or
  // released which claim (server/work-claim-events.mjs).
  WORK_CLAIM_UPDATED: "work_claim.updated",
  // ACT-1a: a room's starter task and Room Guide were seeded once.
  // ACT-1b (/start, landing, receipt UI) waits on S1, RT, and GR2 deployed.
  ROOM_STARTER_SEEDED: "room.starter_seeded"
});

// Room channels (Phase 2 of the Discord/Slack-like redesign): every room has
// one main channel for chat and work plus optional user-created channels.
// Channels live on the projection (state.channels, keyed by id); messages
// carry channelId. Rooms created before channels existed backfill #general
// on replay via ensureDefaultChannel, so no data migration is needed.
export const DEFAULT_CHANNEL_ID = "general";
export const MAX_CHANNELS_PER_ROOM = 50;
export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,47}$/;

const JOINED_VIA_REFUSED = "invalid joinedVia";

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
// A post into an archived channel is a conflict with the archive state, not a
// bad command: docs/openapi.yaml "Room channels (Phase 2)" documents 409
// channel_archived. The reducer carries the code and the command surface maps it.
export const CHANNEL_ARCHIVED_CODE = "channel_archived";
export const trustOffMessage = targetId =>
  `Room Trust is off: cross-owner assign and wake are blocked${targetId ? ` (${targetId})` : ""}. Ask the room owner to turn Trust on.`;

// --- PRIV-2 history visibility ---
// "all": members read the whole history. "since_join": a member reads
// messages and events from their own join onward. The owner and members who
// hold manage_members always read everything. Without a recorded setting,
// link guests and agent guests start at their join point in every room. Rooms
// created before historyDefaultsVersion 1 get the same computed default
// (Potter, Oct 10 2026); nothing is written, so old logs replay unchanged, and
// an owner's explicit "all" still gives guests the full history.
export const HISTORY_VISIBILITIES = Object.freeze(["all", "since_join"]);
export const HISTORY_DEFAULTS_VERSION = 1;
export const ROOM_EXPORT_FORMATS = Object.freeze(["jsonl", "html"]);
const LINK_GUEST_ID = /^guest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isHistoryGuestMemberId(memberId) {
  return typeof memberId === "string" && (LINK_GUEST_ID.test(memberId) || memberId.startsWith("guest-agent-"));
}
export function historyVisibility(state) {
  const stored = state?.room?.historyVisibility;
  const value = HISTORY_VISIBILITIES.includes(stored?.value) ? stored.value : null;
  return {
    value,
    guestsSinceJoin: value === null,
    revision: Number.isSafeInteger(stored?.revision) ? stored.revision : 0,
    setById: typeof stored?.setById === "string" ? stored.setById : null,
    setAt: typeof stored?.setAt === "string" ? stored.setAt : null
  };
}
export function memberHistoryVisibility(state, memberId) {
  const room = state?.room;
  if (!room || typeof memberId !== "string" || memberId === room.ownerId) return "all";
  const member = state.members?.[memberId];
  if (Array.isArray(member?.permissions) && member.permissions.includes("manage_members")) return "all";
  const setting = historyVisibility(state);
  if (setting.value) return setting.value;
  // An agent that joined through a guest share link keeps its identity id as
  // its member id, so member.added records how it joined (historyGuest).
  const historyGuest = isHistoryGuestMemberId(memberId) || member?.historyGuest === true;
  return setting.guestsSinceJoin && historyGuest ? "since_join" : "all";
}
// --- end PRIV-2 ---

// Public receipts stay off until the owner records room.public_receipts_set.
// Absent means off, so older logs replay without a publicReceipts field.
export function publicReceipts(state) {
  const stored = state?.room?.publicReceipts;
  if (!stored || typeof stored.enabled !== "boolean") return { enabled: false };
  return {
    enabled: stored.enabled,
    revision: Number.isSafeInteger(stored.revision) ? stored.revision : 0,
    setById: typeof stored.setById === "string" ? stored.setById : null,
    setAt: typeof stored.setAt === "string" ? stored.setAt : null
  };
}

// --- GR2: public room page, join link, public name, public task. Absent means off. ---
function optIn(stored) {
  if (!stored || typeof stored.enabled !== "boolean") return { enabled: false };
  return {
    enabled: stored.enabled,
    revision: Number.isSafeInteger(stored.revision) ? stored.revision : 0,
    setById: typeof stored.setById === "string" ? stored.setById : null,
    setAt: typeof stored.setAt === "string" ? stored.setAt : null
  };
}

export function publicPage(state) {
  return optIn(state?.room?.publicPage);
}

export function joinLink(state) {
  return optIn(state?.room?.joinLink);
}

export function publicName(member) {
  return optIn(member?.publicName);
}

export function publicTask(item) {
  return optIn(item?.publicTask);
}
// --- end GR2 ---

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
  const member = state?.members && Object.hasOwn(state.members, memberId) ? state.members[memberId] : null;
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

// Spend-pricing kill switch: the owner can disable the priced-tool gate for
// the room (room.spend_pricing_set). Event-sourced and carried on the
// projection; server/spend-grants.mjs prices nothing while disabled. Absent
// state means enabled — the pre-switch behaviour. Unlike the allowance, this
// is a boolean lever, not a budget: disabled restores the room to exactly its
// pre-gate behaviour (tools forward free, no charges, no rows written).
export function spendPricingEnabled(state) {
  const stored = state?.room?.spendPricing;
  if (!stored) return true;
  return stored.enabled !== false;
}

function setSpendPricing(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may set spend pricing");
  const { enabled } = incoming.data ?? {};
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (Object.keys(incoming.data ?? {}).some(key => key !== "enabled")) throw new Error("spend pricing takes only enabled");
  const previous = state.room.spendPricing ?? null;
  state.room.spendPricing = {
    enabled,
    revision: (previous?.revision ?? 0) + 1,
    setById: incoming.actorId,
    setAt: incoming.at
  };
}
// Default autonomy for collaborating agents: they can steer, take work,
// complete it, and verify. Attenuated: no manage_members / decide /
// write_external / invite_member (those stay owner or explicit identity-link).
export const AGENT_AUTONOMY_PERMISSIONS = Object.freeze(["steer", "accept_work", "complete_work", "verify"]);
// Agent-safe standing invite scope (chat/contribute/review/collaborate).
// invite_member holders may mint these without holding them; they cannot
// grant manage_members/decide/invite_member via invite-code.
export const AGENT_INVITE_SAFE_PERMISSIONS = AGENT_AUTONOMY_PERMISSIONS;
// Permissions no invitation mechanism may ever confer, whichever door the
// invitation comes through: membership administration, decisions, and
// inviting stay with members who hold them directly, never with whoever
// redeems an invite. The agent-invite door refuses them at mint
// (server/agent-invites.mjs) and the share-link grant is capped by the same
// set (server/share-links.mjs, #3549) — one definition, every door.
export const NEVER_GRANT = Object.freeze(["manage_members", "decide", "invite_member"]);
export const AGENT_ADMIN_PERMISSIONS = Object.freeze(["manage_members", "decide"]);

// Owner, manage_members, or invite_member (agents may hold invite_member
// without manage_members/decide). Used by invite-code mint/redeem.
export function canInviteMembers(state, memberId) {
  const member = state?.members && Object.hasOwn(state.members, memberId) ? state.members[memberId] : null;
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
// Live member.added commands stamp this. Events written before it omit the
// field and keep replaying, including a bootstrap owner named "Room owner".
// v2 (r50): the G16b first-word collision rule. Events stamped v1 were admitted
// without it (Oct 5-15 muse-room has two), so replay checks a v1 stamp with
// the v1 rules; a tightened rule needs a new version, not a rewrite of v1.
// v3: a removed member's name stays reserved in the room — live admission
// also checks inactive member records (the joining member's own record is
// never in the map at this point, and excludeId keeps that explicit).
// Events stamped v1/v2 replay without the reservation, as admitted.
export const DISPLAY_NAME_POLICY_VERSION = 3;
const DISPLAY_NAME_POLICY_VERSIONS = new Set([1, 2, 3]);
function assertStampedDisplayName(data, members) {
  const version = data.displayNamePolicyVersion;
  if (!DISPLAY_NAME_POLICY_VERSIONS.has(version)) return;
  assertMemberDisplayNameAvailable(data.displayName, members, {
    firstWordRule: version >= 2,
    includeInactive: version >= 3,
    excludeId: data.memberId ?? null,
  });
}
// Live message.pinned commands stamp this (store.command injects it at
// admission). Pin events written before the F-1 DM-party rule omit the field
// and must keep replaying; the reducer only enforces the party check on
// stamped events.
export const PIN_DM_PARTY_POLICY_VERSION = 1;

// Prototype names are denied as ids even when they satisfy the charset, so
// a plain object keyed by id can never resolve (or be assigned) through
// Object.prototype. Callers that validate user-supplied ids check
// isReservedId first so the rejection can name the real cause instead of
// collapsing into a charset error (#3013).
export const RESERVED_IDS = Object.freeze(["constructor", "prototype", "__proto__"]);
export const isReservedId = value => typeof value === "string" && RESERVED_IDS.includes(value);

export function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) && !isReservedId(value);
}

// #1004 follow-up: member projections are plain objects from JSON.parse, so
// members[id] resolves inherited Object.prototype names ("toString",
// "valueOf", "hasOwnProperty", ...) that pass validId. Every "must be an
// active room member" check on a caller-supplied id must resolve through
// this helper so only own members of the projection satisfy it.
export const ownMember = (members, id) =>
  (members && Object.hasOwn(members, id) ? members[id] : undefined);

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

// #3408: applyEvent used to open with a whole-state structuredClone. The
// clone measured 78-98% of applyEvent's cost, and ~75% of the cloned bytes
// are replay bookkeeping (eventLog + the two seen maps) that the persisted
// projection discards. The bookkeeping needs container isolation, not deep
// copies:
//   - eventLog is append-only here (one push per applied event) and its
//     entries are the applied envelopes, which no handler or consumer
//     mutates once logged (the newest entry is the caller's own `incoming`
//     object even under a full structuredClone);
//   - seenEvents values are fingerprint strings and seenIdempotencyKeys
//     values are event-id strings — immutable, replaced wholesale per key.
// So the bookkeeping containers get fresh shallow copies (each returned
// state owns its array/maps, so pushes and key sets never leak across
// states) while every content branch keeps the full structuredClone.
// The returned state is value-identical to the structuredClone result;
// the #3408 replay-equivalence digest chains pin that claim.
//
// WRITE-PATH-WINS win 2 (50x audit S1): the messages branch is the dominant
// content clone (~870-char bodies x five-figure counts), and the message
// handlers split cleanly by how they touch it:
//   - message.posted only reads existing messages and pushes new ones
//     (plus a possible ":channel" copy) — the array needs a fresh slice,
//     never an element clone;
//   - message.edited / message.deleted / message.redacted / poll.voted
//     rewrite elements in place, but only the addressed message and its
//     ":channel" copy — slice the array and deep-clone just those
//     elements, so an in-place rewrite can never reach the input state's
//     objects.
// Every other branch (members, channels, workItems, replyRequests, ...)
// keeps the full structuredClone, and every other event type keeps the
// full messages clone: handlers that range over messages (redact's
// receipt sweep reads workItems, which stays cloned) stay safe by
// construction. Sharing unaddressed elements is safe because no handler
// in the light set mutates them, and any later event that does address
// one clones it first under the same rule. The projection-write-through
// equivalence battery pins input-state immutability for the light set.
const MESSAGE_REWRITE_TYPES = new Set([
  EVENT_TYPES.MESSAGE_EDITED, EVENT_TYPES.MESSAGE_DELETED,
  EVENT_TYPES.MESSAGE_REDACTED, EVENT_TYPES.POLL_VOTED
]);
function lightMessageCloneIds(incoming) {
  if (incoming?.type === EVENT_TYPES.MESSAGE_POSTED) return new Set();
  if (!MESSAGE_REWRITE_TYPES.has(incoming?.type)) return null;
  const messageId = incoming.data?.messageId;
  if (typeof messageId !== "string" || !messageId) return null;
  return new Set([messageId, `${messageId}:channel`]);
}
function cloneStateForApply(current, incoming, journal = null) {
  const state = { ...current, ...(journal ?? {}) };
  if (!journal && Array.isArray(current.eventLog)) state.eventLog = current.eventLog.slice();
  if (!journal && current.seenEvents && typeof current.seenEvents === "object") {
    state.seenEvents = { ...current.seenEvents };
  }
  if (!journal && current.seenIdempotencyKeys && typeof current.seenIdempotencyKeys === "object") {
    state.seenIdempotencyKeys = { ...current.seenIdempotencyKeys };
  }
  const lightMessages = lightMessageCloneIds(incoming);
  for (const key of Object.keys(state)) {
    if (key === "eventLog" || key === "seenEvents" || key === "seenIdempotencyKeys") continue;
    if (key === "messages" && lightMessages !== null && Array.isArray(current.messages)) {
      state.messages = lightMessages.size === 0
        ? current.messages.slice()
        : current.messages.map(message => (message && lightMessages.has(message.id) ? structuredClone(message) : message));
      continue;
    }
    state[key] = structuredClone(current[key]);
  }
  return state;
}

export function applyEvent(current, incoming) {
  return applyEventWithJournal(current, incoming);
}

// A replay owns its journal for the entire fold. Clone it once, rather than
// copying every accumulated event ID and log entry for each subsequent event.
// Domain state still goes through the same immutable reducer path; callers never
// observe intermediate journal aliases and the input state remains untouched.
export function replayEvents(current, events) {
  const journal = {eventLog:[...(current.eventLog ?? [])],
    seenEvents:{...(current.seenEvents ?? {})},
    seenIdempotencyKeys:{...(current.seenIdempotencyKeys ?? {})}};
  let state = current;
  for (const incoming of events) state = applyEventWithJournal(state,incoming,journal);
  return state;
}

function applyEventWithJournal(current, incoming, journal = null) {
  const state = cloneStateForApply(current, incoming, journal);
  validateEnvelope(incoming);
  // H-11: fingerprint via eventFingerprint (handler-stamped markers excluded)
  // so the stored fingerprint agrees with the logged (post-handler) event.
  const fingerprint = eventFingerprint(incoming);

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
    [EVENT_TYPES.ROOM_SPEND_PRICING_SET]: setSpendPricing,
    [EVENT_TYPES.ROOM_TRUST_SET]: setRoomTrust,
    [EVENT_TYPES.ROOM_PUBLIC_RECEIPTS_SET]: setPublicReceipts,
    // --- GR2 ---
    [EVENT_TYPES.ROOM_PUBLIC_PAGE_SET]: setPublicPage,
    [EVENT_TYPES.ROOM_JOIN_LINK_SET]: setJoinLink,
    [EVENT_TYPES.MEMBER_PUBLIC_NAME_SET]: setPublicName,
    [EVENT_TYPES.WORK_PUBLIC_SET]: setPublicTask,
    // --- end GR2 ---
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
    // --- PRIV-1 message redaction ---
    [EVENT_TYPES.MESSAGE_REDACTED]: redactMessage,
    [EVENT_TYPES.RECEIPT_EVIDENCE_WITHDRAWN]: recordEvidenceWithdrawn,
    // --- end PRIV-1 message redaction ---
    // --- PRIV-2 history visibility and export authority ---
    [EVENT_TYPES.ROOM_HISTORY_VISIBILITY_SET]: setHistoryVisibility,
    [EVENT_TYPES.ROOM_EXPORTED]: recordRoomExport,
    // --- end PRIV-2 ---
    [EVENT_TYPES.REPLY_REQUEST_CANCELLED]: cancelReplyRequest,
    // Reactions were removed (2026-10). Old logs still carry
    // message.reaction_set; replay skips them.
    "message.reaction_set": () => {},
    [EVENT_TYPES.POLL_VOTED]: votePoll,
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
    [EVENT_TYPES.DM_CONSENT_CHANGED]: recordDmConsentChange,
    [EVENT_TYPES.LAND_UPDATED]: recordLandUpdate,
    [EVENT_TYPES.WORK_CLAIM_UPDATED]: recordWorkClaimUpdate,
    [EVENT_TYPES.ROOM_STARTER_SEEDED]: recordStarterSeeded
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
    if (key === "pullRequests" && (!Array.isArray(value) || value.length > 16 || value.some(v => typeof v !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}$/.test(v)))) throw new Error(`Invalid ${key}`);
    if (key === "blocks" && (!Array.isArray(value) || value.length > 64 || value.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string" || !entry.path.trim() || entry.path.length > 512 || (entry.block != null && (typeof entry.block !== "string" || entry.block.length > 80)) || (entry.region != null && (typeof entry.region !== "string" || entry.region.length > 80))))) throw new Error(`Invalid ${key}`);
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
    // "added" covers the initial board write, "removed" a board delete and
    // "reassigned" a claimant handoff, so every land-queue mutation is
    // observable in the event log.
    if (key === "changed" && (!Array.isArray(value) || value.length < 1 || value.length > 8
      || value.some(change => typeof change !== "string" || !["green", "red", "behind", "merged", "tip", "added", "removed", "reassigned"].includes(change)))) throw new Error(`Invalid ${key}`);
    if (key === "state" && (!value || typeof value !== "object" || Array.isArray(value)
      || !["pending", "green", "red"].includes(value.checks)
      || typeof value.behind !== "boolean"
      || !["mergeable", "behind", "conflict", "unknown", "merged"].includes(value.mergeable)
      || typeof value.merged !== "boolean")) throw new Error(`Invalid ${key}`);
    // work_claim.updated names the pull a merge or close settled. The handler
    // requires it only for those actions; the envelope only admits this shape.
    if (key === "pullRequest" && (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.url !== "string"
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}$/.test(value.url)
      || (value.outcome !== "merged" && value.outcome !== "closed")
      || Object.keys(value).length !== 2)) throw new Error(`Invalid ${key}`);
    // ACT-1a: starter welcome buttons. Each entry is a claim id plus a label.
    if (key === "actions" && (!Array.isArray(value) || value.length > 16 || value.some(action => !action || typeof action !== "object" || Array.isArray(action)
      || typeof action.claimId !== "string" || !validId(action.claimId)
      || typeof action.label !== "string" || !action.label.trim() || action.label.length > 512
      || Object.keys(action).some(field => field !== "claimId" && field !== "label")))) throw new Error(`Invalid ${key}`);
    // work_claim.updated deletion receipts name stranded dependents: claim ids.
    if (key === "dependents" && (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== "string" || !validId(v)))) throw new Error(`Invalid ${key}`);
    // Polls (missing-features #5): a kind "poll" message carries a poll
    // payload { question, options, allowMultiple }. The envelope guard admits
    // the object key; the applier runs the full option validation.
    if (!["string", "boolean", "number"].includes(typeof value) && !["permissions", "paths", "checksClaimed", "capabilities", "preferences", "budget", "outputs", "segments", "signedEvidence", "labels", "scopes", "acceptedScopes", "changed", "state", "pullRequest", "pullRequests", "blocks", "actions", "dependents", "poll"].includes(key)) throw new Error(`Invalid ${key}`);
  }
}

function createRoom(state, incoming) {
  if (state.room) throw new Error("Room already exists");
  requireFields(incoming.data, ["roomId", "title", "purpose", "ownerId"]);
  if (incoming.data.kind !== undefined && !ROOM_KINDS.includes(incoming.data.kind)) throw new Error("Room kind must be personal or organization");
  if (incoming.roomId !== incoming.data.roomId) throw new Error("Room event id mismatch");
  if (incoming.actorId !== incoming.data.ownerId) throw new Error("Room must be created by its owner");
  // PRIV-2: rooms created after history visibility shipped carry version 1,
  // which starts link guests and agent guests at their join point.
  if (incoming.data.historyDefaultsVersion !== undefined && incoming.data.historyDefaultsVersion !== HISTORY_DEFAULTS_VERSION) {
    throw new Error("Unsupported history defaults version");
  }
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

function setPublicReceipts(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may publish receipts");
  if (typeof incoming.data.enabled !== "boolean") throw new Error("Public receipts require enabled as true or false");
  const previous = state.room.publicReceipts ?? null;
  state.room.publicReceipts = {
    enabled: incoming.data.enabled,
    revision: (previous?.revision ?? 0) + 1,
    setById: incoming.actorId,
    setAt: incoming.at
  };
}

// --- PRIV-2 writers: owner-only. Absent stays absent, so older logs replay byte-identically. ---
function setHistoryVisibility(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may set history visibility");
  if (!HISTORY_VISIBILITIES.includes(incoming.data.historyVisibility)) throw new Error("History visibility is all or since_join");
  const previous = state.room.historyVisibility ?? null;
  state.room.historyVisibility = {
    value: incoming.data.historyVisibility,
    revision: (previous?.revision ?? 0) + 1,
    setById: incoming.actorId,
    setAt: incoming.at
  };
}

// The export itself is a read. This audit record changes no projection field.
function recordRoomExport(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may export the room");
  if (!ROOM_EXPORT_FORMATS.includes(incoming.data.format)) throw new Error("Export format is jsonl or html");
}
// --- end PRIV-2 writers ---

// --- GR2 opt-in writers. Same shape as public receipts: owner or the member who owns the text. ---
function writeOptIn(previous, incoming) {
  return {
    enabled: incoming.data.enabled,
    revision: (previous?.revision ?? 0) + 1,
    setById: incoming.actorId,
    setAt: incoming.at
  };
}

function requireEnabled(incoming, label) {
  if (typeof incoming.data.enabled !== "boolean") throw new Error(`${label} requires enabled as true or false`);
}

function setPublicPage(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may publish the room page");
  requireEnabled(incoming, "Public room page");
  state.room.publicPage = writeOptIn(state.room.publicPage ?? null, incoming);
}

function setJoinLink(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId) throw new Error("Only the Room owner may share a join link");
  requireEnabled(incoming, "Join link");
  state.room.joinLink = writeOptIn(state.room.joinLink ?? null, incoming);
}

function setPublicName(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireEnabled(incoming, "Public name");
  actor.publicName = writeOptIn(actor.publicName ?? null, incoming);
}

function setPublicTask(state, incoming) {
  requireFields(incoming.data, ["workItemId"]);
  const actor = requireMember(state, incoming.actorId);
  const item = state.workItems[incoming.data.workItemId];
  if (!item) throw new Error("Unknown work item");
  if (actor.id !== state.room.ownerId && actor.id !== item.proposedById) throw new Error("Only the Room owner or the proposer may publish this task");
  requireEnabled(incoming, "Public task");
  item.publicTask = writeOptIn(item.publicTask ?? null, incoming);
}
// --- end GR2 ---

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
  if (Object.hasOwn(state.members, memberId)) throw new Error("Member already exists");
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
  // Reserved, duplicate, confusable, and control-character names are refused
  // on the live command path. The bootstrap owner is exempt so a room can
  // still be created under "Room owner". Older events omit the policy stamp.
  if (!isBootstrapOwner) assertStampedDisplayName(incoming.data, state.members);
  // Round-2 #101: a member record may be bound to a global agent identity.
  if (incoming.data.identityId != null
    && (typeof incoming.data.identityId !== "string" || incoming.data.identityId.length > 64)) throw new Error("identityId must be a short string");
  if (incoming.data.historyGuest != null && incoming.data.historyGuest !== true) throw new Error("Invalid historyGuest");
  if (incoming.data.agentType != null
    && (typeof incoming.data.agentType !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(incoming.data.agentType))) {
    throw new Error("agentType must be a short catalog id");
  }
  // Referral attribution: optional, validated, never self-referential. The
  // referrer must already be a member — checked at record time; the event
  // handler guards the shape so a corrupt log cannot forge it.
  // Only the one-time agent code path stamps this (server/agent-invites.mjs). It lets the
  // minter see "joined with a one-time code" in Updates; any other value is refused.
  if (incoming.data.joinedVia != null && incoming.data.joinedVia !== "one-time-code") throw new Error(JOINED_VIA_REFUSED);
  if (incoming.data.referredBy != null) {
    if (typeof incoming.data.referredBy !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(incoming.data.referredBy)) {
      throw new Error("referredBy must be a member id");
    }
    if (incoming.data.referredBy === memberId) throw new Error("a member cannot refer themselves");
    // Historical events admitted prototype names as referrers. Preserve their
    // replay; live commands enforce own-member attribution before persistence.
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
    // ACT-1a: Room Guide is an agent member the analytics path treats as system.
    // Omitted unless set, so older projections replay byte-identically.
    ...(incoming.data.system === true ? { system: true } : {}),
    // priv-share-link-agent-reads-full-history: set when an agent joins through
    // a guest share link. It reads like a link guest under the default history
    // setting. Omitted otherwise so older projections replay byte-identically.
    ...(incoming.data.historyGuest === true ? { historyGuest: true } : {}),
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
  if (Object.hasOwn(state.members, memberId)) throw new Error("Member already exists");
  requirePermission(state, invitedByMemberId, "manage_members");
  const rolePolicy = INVITATION_ROLE_POLICIES[rolePolicyVersion];
  const rolePermissions = rolePolicy && Object.hasOwn(rolePolicy, role) && rolePolicy[role];
  if (!rolePermissions || permissions.length !== rolePermissions.length || permissions.some((permission, index) => permission !== rolePermissions[index])) {
    throw new Error("Invitation role permissions do not match the stored role policy");
  }
  if (authorityPolicyVersion !== MEMBERSHIP_AUTHORITY_POLICY_VERSION) throw new Error("Unsupported membership authority policy");
  validatePermissions(permissions, "human");
  requireScopedMemberAdministration(state, invitedByMemberId, memberId, null, permissions);
  // Reserved, duplicate, confusable, and control-character names are refused
  // on the invitation join path too. Older events omit the policy stamp, so
  // replay never throws for already-admitted members.
  assertStampedDisplayName(incoming.data, state.members);
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
  // A self-leave with unchanged permissions grants and removes no authority,
  // so the scoped-administration rule does not apply to it. Without this,
  // an invite_member-only human could not leave (account deletion: 422).
  if (incoming.data.authorityPolicyVersion === MEMBERSHIP_AUTHORITY_POLICY_VERSION) {
    if (!isLeaveRequest(state, incoming)) requireScopedMemberAdministration(state, incoming.actorId, member.id, member, incoming.data.permissions);
  } else if (incoming.data.authorityPolicyVersion != null && incoming.data.authorityPolicyVersion !== 1) {
    throw new Error("Unsupported membership authority policy");
  }
  if (member.id === state.room.ownerId && (!incoming.data.active || !incoming.data.permissions.includes("manage_members"))) throw new Error("Owner must retain membership administration");
  member.active = incoming.data.active;
  member.permissions = [...incoming.data.permissions];
  member.revision += 1;
  // Display-name policy v3: how a membership ended decides whether the
  // member's name stays reserved in the room. Account deletion ends the
  // membership AND frees the name (bug-deleted-account-member-stays-active-
  // 20261010: the next joiner with that name must not 422); the deletion
  // flow stamps membershipEndReason on its deactivation commands, and the
  // marker is derived here and mirrored onto the event like delegatedAdmin,
  // never trusted from a stored record alone. Any other ending (owner
  // removal, self-leave) keeps the name reserved. Reactivation clears it.
  if (incoming.data.active === false && incoming.data.membershipEndReason === "account_deleted") {
    member.membershipEndedBy = "account_deleted";
    incoming.data.membershipEndedBy = "account_deleted";
  } else if (incoming.data.active === true) {
    delete member.membershipEndedBy;
    delete incoming.data.membershipEndedBy;
  }
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
  if (channel.id === DEFAULT_CHANNEL_ID) throw new Error("The main channel can't be renamed");
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

function recordDmConsentChange(state, incoming) {
  requireMember(state, incoming.actorId);
  // Receipt only. The dm_consents table is the source of truth (RC-2026-09-19-070);
  // this sequenced event exists so a live session can refresh its pending-DM view.
  requireFields(incoming.data, ["requesterId", "targetId", "status"]);
  if (incoming.data.requesterId === incoming.data.targetId) throw new Error("Cannot consent with yourself");
}

function recordPeerDm(state, incoming) {
  requireMember(state, incoming.actorId);
  // --- PRIV-1 message redaction ---
  const fields = ["messageId", "threadId", "bondId", "fromIdentityId", "toIdentityId"];
  if (!isRedactedBody(incoming.data)) fields.push("body");
  requireFields(incoming.data, fields);
  // --- end PRIV-1 message redaction ---
  if (incoming.data.fromIdentityId === incoming.data.toIdentityId) throw new Error("Cannot DM yourself");
  // Receipt only. Peer DM bodies stay out of room chat (state.messages).
}

// Land-queue wake receipt. The land_queue table is the source of truth, so
// this records nothing on the projection. It validates the thin payload the
// claimant is woken with: pr, head, state, and what changed. "added" covers
// the initial board write, "removed" a board delete and "reassigned" a
// claimant handoff, so every land-queue mutation is observable.
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
    || data.changed.some(change => !["green", "red", "behind", "merged", "tip", "added", "removed", "reassigned"].includes(change))) {
    throw new Error("Event data missing changed");
  }
}

export const WORK_CLAIM_EVENT_ACTIONS = Object.freeze(["created", "claimed", "state_changed", "reviewed", "released", "reassigned", "renewed", "lease_expired", "pr_merged", "pr_closed", "ci_changed", "deleted", "premise_flagged", "premise_cleared", "closed"]);
const WORK_CLAIM_EVENT_STATES = ["unclaimed", "claimed", "in_progress", "blocked", "delivered", "done", "closed"];

// Thin receipt: validated, never copied into the projection.
function recordStarterSeeded(state, incoming) {
  requireFields(incoming.data, ["templateSlug", "intentKind"]);
  const actor = requireMember(state, incoming.actorId);
  if (actor.id !== state.room.ownerId && actor.system !== true) throw new Error("Only the Room owner may seed a starter");
  if (state.room.starterSeeded) throw new Error("Starter already seeded");
  if (!/^[a-z0-9-]{1,64}$/.test(incoming.data.templateSlug)) throw new Error("Invalid templateSlug");
  if (!/^[a-z0-9-]{1,32}$/.test(incoming.data.intentKind)) throw new Error("Invalid intentKind");
  state.room.starterSeeded = {
    templateSlug: incoming.data.templateSlug,
    intentKind: incoming.data.intentKind,
    at: incoming.at
  };
}

function recordWorkClaimUpdate(state, incoming) {
  requireMember(state, incoming.actorId);
  const data = incoming.data ?? {};
  if (typeof data.workClaim !== "string" || !data.workClaim.trim() || data.workClaim.length > 256) throw new Error("Event data missing workClaim");
  if (WORK_CLAIM_EVENT_ACTIONS.includes(data.action) === false) throw new Error("Event data missing action");
  if (!WORK_CLAIM_EVENT_STATES.includes(data.claimState)) throw new Error("Event data missing claimState");
  if (!(data.ownerId === null || typeof data.ownerId === "string")) throw new Error("Event data missing ownerId");
  if (!(data.leaseExpiresAt === null || (typeof data.leaseExpiresAt === "string" && !Number.isNaN(Date.parse(data.leaseExpiresAt))))) {
    throw new Error("Event data missing leaseExpiresAt");
  }
  if (!Array.isArray(data.paths)) throw new Error("Event data missing paths");
  if (data.action === "pr_merged" || data.action === "pr_closed") {
    const pull = data.pullRequest;
    const outcome = data.action === "pr_merged" ? "merged" : "closed";
    if (!pull || typeof pull.url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9}$/.test(pull.url) || pull.outcome !== outcome) {
      throw new Error("Event data missing pullRequest");
    }
  }
  const closing = data.action === "closed";
  if ((data.reason !== undefined || closing) && !(closing ? data.claimState === "closed" && ["closed", "cancelled"].includes(data.reason)
    : ["ci_changed", "reviewed", "closed", "cancelled"].includes(data.reason))) throw new Error("Event data missing reason");
  if (data.attention !== undefined && !["assigned", "lease_expiring", "lease_expired", "ci_failed", "changes_requested"].includes(data.attention)) throw new Error("Event data missing attention");
  if (data.attentionMemberId !== undefined && (typeof data.attentionMemberId !== "string" || data.attentionMemberId.length === 0 || data.attentionMemberId.length > 128)) throw new Error("Event data missing attentionMemberId");
  if (data.ciState !== undefined && !["pending", "success", "failure", "neutral"].includes(data.ciState)) throw new Error("Event data missing ciState");
  if (data.verdict !== undefined && !["approve", "changes_requested", "comment"].includes(data.verdict)) throw new Error("Event data missing verdict");
  if (data.action === "ci_changed" && (data.reason !== "ci_changed" || !data.ciState)) throw new Error("Event data missing ciState");
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

// Lease-renewal check-ins: a claim's lease is extended only when the holder
// posts a public progress update in the room after the current lease window
// began. Renewals are discussed in the channel — never silent extensions —
// so a stale holder can't hold scope indefinitely without showing work.


// The cited progress check-in must be a live public message in this room,
// authored by the claim holder, and newer than the current lease window's
// start (the acquisition, or the previous renewal). The same room's
// projection is the lookup, so a cross-room id never resolves, and a DM
// (toMemberId) can never serve as the public check-in.

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
  requirePublicDecisionSource(state, incoming.data.sourceMessageId);
  const statement = String(incoming.data.statement);
  if (statement !== statement.trim() || statement.length > 500) {
    throw new Error("Decision statement must be trimmed text up to 500 characters");
  }
  if (incoming.data.note !== undefined && incoming.data.note !== null
    && (typeof incoming.data.note !== "string" || incoming.data.note !== incoming.data.note.trim() || incoming.data.note.length > 500)) {
    throw new Error("Decision note must be trimmed text up to 500 characters");
  }
}

// Same path grammar as server/claim-scopes.mjs: a file, folder/** or **.
const claimPath = value => {
  const text = String(value).trim().replace(/^\.\//, "");
  if (text === "**") return { path: "", subtree: true };
  const subtree = text.endsWith("/**");
  return { path: (subtree ? text.slice(0, -3) : text).replace(/\/+$/, ""), subtree };
};
const covers = (scope, other) => scope.path === other.path || (scope.subtree && (!scope.path || other.path.startsWith(`${scope.path}/`)));
export function claimOverlaps(state, workItemId, repository, paths, at) {
  const mine = paths.map(claimPath);
  const repo = String(repository).trim().toLowerCase();
  const found = [];
  for (const other of Object.values(state.workItems ?? {})) {
    if (other.id === workItemId || !other.claim || !claimIsActive(other.claim, at)) continue;
    if (String(other.claim.repository).trim().toLowerCase() !== repo) continue;
    const shared = other.claim.paths.filter(path => { const theirs = claimPath(path); return mine.some(own => covers(own, theirs) || covers(theirs, own)); });
    if (shared.length) found.push({ workItemId: other.id, holderId: other.claim.holderId, paths: shared.slice(0, 16) });
    if (found.length >= 10) break;
  }
  return found;
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

// H-11: keys a handler stamps onto incoming.data as derived audit markers
// (not part of the caller's event). The fingerprint excludes them so the
// stored fingerprint agrees with the immutable log entry: a retry reusing
// the same (already stamped) object — or a pristine copy — is idempotent
// instead of throwing a spurious "Conflicting reuse of event id". If a
// handler stamps a new marker key, add it here.
const HANDLER_STAMPED_DATA_KEYS = ["delegatedAdmin"];

function eventFingerprint(incoming) {
  const data = incoming.data;
  if (data && typeof data === "object") {
    let stripped = null;
    for (const key of HANDLER_STAMPED_DATA_KEYS) {
      if (Object.hasOwn(data, key)) {
        stripped ??= { ...data };
        delete stripped[key];
      }
    }
    if (stripped) return stableStringify({ ...incoming, data: stripped });
  }
  return stableStringify(incoming);
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

// Compose the message domain once; replay and live commands use identical guards.
const { postMessage, editMessage, deleteMessage, redactMessage, recordEvidenceWithdrawn,
  votePoll, pinMessage, unpinMessage } = createMessageReducers({ requireMember,
  knownMember, requireFields, requireWorkItem, proposalContext, validId, messageChannelId,
  defaultChannelId: DEFAULT_CHANNEL_ID, channelArchivedCode: CHANNEL_ARCHIVED_CODE,
  pinLimit: PIN_LIMIT, pinDmPartyPolicyVersion: PIN_DM_PARTY_POLICY_VERSION });

// Compose work transitions once with the same authority guards as other domains.
const { proposeWork, acceptWork, startWork, blockWork, recordHandoff, clearHalt, resolveBlocker, completeWork, supersedeWork, acquireClaim, releaseClaim, renewClaim, recordVerification, applySession, recordOwnerDecision } = createWorkReducers({ WORK_STATES, requirePermission, requireFields, requireMember, knownMember, receiptHasKnownProducer, requireWorkItem, assertRoomTrust, roomPolicy, claimIsActive, claimOverlaps, hasPermission, matchesReceipt, hasConfirmedIndependentPass, requirePublicDecisionSource });
