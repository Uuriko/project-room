import { REACTIONS } from "./conversation.js";
import { proposalContext, nativeTextEvidence, reportedProducer } from "./work-packet.js";
import { CHARTER_TYPE, charterFromEvent } from "./room-charter.js";
import { REPLY_CANCELLED, prepareReplyPost, recordReplyPost, cancelReplyRequest } from "./reply-requests.js";
import { WORK_HELP_UPDATED, helpFromEvent } from "./work-help.js";
import { HELP_OFFER_OPENED, HELP_OFFER_UPDATED, helpOfferFromEvent } from "./help-offers.js";
import { SESSION_EVENT_TYPES, applySessionFields } from "./work-item-session.js";

export const EVENT_TYPES = Object.freeze({
  ROOM_CREATED: "room.created",
  ROOM_CHARTER_UPDATED: CHARTER_TYPE,
  MEMBER_ADDED: "member.added",
  MEMBER_JOINED_VIA_INVITATION: "member.joined_via_invitation",
  MEMBER_ACCESS_CHANGED: "member.access_changed",
  MEMBER_STATUS_UPDATED: "member.status_updated",
  MESSAGE_POSTED: "message.posted",
  REPLY_REQUEST_CANCELLED: REPLY_CANCELLED,
  MESSAGE_REACTION_SET: "message.reaction_set",
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
  VERIFICATION_RECORDED: "verification.recorded",
  OWNER_DECISION_RECORDED: "owner.decision_recorded",
  SESSION_STARTED: SESSION_EVENT_TYPES.STARTED,
  SESSION_STATUS_CHANGED: SESSION_EVENT_TYPES.STATUS_CHANGED,
  SESSION_STOP_REQUESTED: SESSION_EVENT_TYPES.STOP_REQUESTED,
  SESSION_STOPPED: SESSION_EVENT_TYPES.STOPPED,
  CAPABILITIES_ADVERTISED: "capabilities.advertised"
});

export const PERMISSIONS = Object.freeze(["steer", "decide", "manage_members", "manage_claims", "accept_work", "complete_work", "verify", "write_external"]);

// A command may check a work revision without advancing it (for example help).
// Historical evidence readers must not infer a mutation from a field name alone.
export const WORK_REVISION_TYPES = Object.freeze([
  EVENT_TYPES.WORK_ACCEPTED, EVENT_TYPES.WORK_STARTED, EVENT_TYPES.WORK_BLOCKED, EVENT_TYPES.WORK_BLOCKER_RESOLVED,
  EVENT_TYPES.WORK_COMPLETED, EVENT_TYPES.WORK_SUPERSEDED, EVENT_TYPES.CLAIM_ACQUIRED, EVENT_TYPES.CLAIM_RELEASED,
  EVENT_TYPES.VERIFICATION_RECORDED, EVENT_TYPES.OWNER_DECISION_RECORDED,
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
  }

  const handlers = {
    [EVENT_TYPES.ROOM_CREATED]: createRoom,
    [EVENT_TYPES.ROOM_CHARTER_UPDATED]: updateCharter,
    [EVENT_TYPES.MEMBER_ADDED]: addMember,
    [EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION]: joinMemberViaInvitation,
    [EVENT_TYPES.MEMBER_ACCESS_CHANGED]: changeMemberAccess,
    [EVENT_TYPES.MEMBER_STATUS_UPDATED]: updateMemberStatus,
    [EVENT_TYPES.MESSAGE_POSTED]: postMessage,
    [EVENT_TYPES.REPLY_REQUEST_CANCELLED]: cancelReplyRequest,
    [EVENT_TYPES.MESSAGE_REACTION_SET]: setMessageReaction,
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
    [EVENT_TYPES.VERIFICATION_RECORDED]: recordVerification,
    [EVENT_TYPES.OWNER_DECISION_RECORDED]: recordOwnerDecision,
    [EVENT_TYPES.SESSION_STARTED]: applySession,
    [EVENT_TYPES.SESSION_STATUS_CHANGED]: applySession,
    [EVENT_TYPES.SESSION_STOP_REQUESTED]: applySession,
    [EVENT_TYPES.SESSION_STOPPED]: applySession,
    [EVENT_TYPES.CAPABILITIES_ADVERTISED]: advertiseCapabilities
  };
  const handler = handlers[incoming.type];
  if (!Object.hasOwn(handlers, incoming.type)) throw new Error(`Unsupported event type: ${incoming.type}`);
  handler(state, incoming);

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
    if (typeof value === "string" && (value.length > 4096 || !value.trim())) throw new Error(`Invalid ${key}`);
    if (["expectedRevision", "expectedMemberRevision"].includes(key) && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid ${key}`);
    if (["independentVerificationRequired", "ownerDecisionRequired", "active"].includes(key) && typeof value !== "boolean") throw new Error(`Invalid ${key}`);
    if (["permissions", "paths", "checksClaimed", "capabilities"].includes(key) && (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== "string" || !v.trim() || v.length > 512))) throw new Error(`Invalid ${key}`);
    if (!["string", "boolean", "number"].includes(typeof value) && !["permissions", "paths", "checksClaimed", "capabilities"].includes(key)) throw new Error(`Invalid ${key}`);
  }
}

function createRoom(state, incoming) {
  if (state.room) throw new Error("Room already exists");
  requireFields(incoming.data, ["roomId", "title", "purpose", "ownerId"]);
  if (incoming.roomId !== incoming.data.roomId) throw new Error("Room event id mismatch");
  if (incoming.actorId !== incoming.data.ownerId) throw new Error("Room must be created by its owner");
  state.room = { id: incoming.data.roomId, ...incoming.data, createdAt: incoming.at };
}

function updateCharter(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  if (actor.kind !== "human" || actor.id !== state.room.ownerId) throw new Error("Only the Room owner may change room instructions");
  state.room.charter = charterFromEvent(incoming, state.room.charter ?? null);
}

function addMember(state, incoming) {
  requireFields(incoming.data, ["memberId", "displayName", "kind", "permissions"]);
  const memberId = incoming.data.memberId;
  if (state.members[memberId]) throw new Error("Member already exists");
  const isBootstrapOwner = Object.keys(state.members).length === 0 && memberId === state.room.ownerId;
  if (isBootstrapOwner && incoming.actorId !== memberId) throw new Error("Only the owner may bootstrap membership");
  if (!isBootstrapOwner) requirePermission(state, incoming.actorId, "manage_members");
  if (!["human", "agent"].includes(incoming.data.kind)) throw new Error("Member kind must be human or agent");
  validatePermissions(incoming.data.permissions, incoming.data.kind);
  if (!isBootstrapOwner && incoming.data.authorityPolicyVersion === MEMBERSHIP_AUTHORITY_POLICY_VERSION) {
    requireScopedMemberAdministration(state, incoming.actorId, memberId, null, incoming.data.permissions);
  } else if (incoming.data.authorityPolicyVersion != null && incoming.data.authorityPolicyVersion !== 1) {
    throw new Error("Unsupported membership authority policy");
  }
  if (incoming.data.accountableHumanId && (!isBootstrapOwner || incoming.data.accountableHumanId !== memberId)) {
    if (requireMember(state, incoming.data.accountableHumanId).kind !== "human") throw new Error("Accountable sponsor must be a human member");
  }
  if (isBootstrapOwner && (incoming.data.kind !== "human" || !incoming.data.permissions.includes("manage_members"))) throw new Error("Owner must retain membership administration");
  state.members[memberId] = {
    id: memberId,
    displayName: incoming.data.displayName,
    kind: incoming.data.kind,
    accountableHumanId: incoming.data.accountableHumanId || (incoming.data.kind === "human" ? memberId : state.room.ownerId),
    permissions: [...incoming.data.permissions],
    availability: incoming.data.availability || "unknown",
    active: true,
    revision: 0
  };
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

function validatePermissions(permissions, kind) {
  if (!Array.isArray(permissions) || permissions.some(p => !PERMISSIONS.includes(p)) || new Set(permissions).size !== permissions.length) throw new Error("Invalid permissions");
  if (kind === "agent" && permissions.some(p => ["manage_members", "decide"].includes(p))) throw new Error("Human administration cannot be delegated to an agent");
}

function changeMemberAccess(state, incoming) {
  requirePermission(state, incoming.actorId, "manage_members");
  requireFields(incoming.data, ["memberId", "expectedMemberRevision", "permissions", "active"]);
  const member = Object.hasOwn(state.members, incoming.data.memberId) && state.members[incoming.data.memberId];
  if (!member) throw new Error("Unknown member");
  if (member.revision !== incoming.data.expectedMemberRevision) throw new Error("Stale member revision");
  validatePermissions(incoming.data.permissions, member.kind);
  if (incoming.data.authorityPolicyVersion === MEMBERSHIP_AUTHORITY_POLICY_VERSION) {
    requireScopedMemberAdministration(state, incoming.actorId, member.id, member, incoming.data.permissions);
  } else if (incoming.data.authorityPolicyVersion != null && incoming.data.authorityPolicyVersion !== 1) {
    throw new Error("Unsupported membership authority policy");
  }
  if (member.id === state.room.ownerId && (!incoming.data.active || !incoming.data.permissions.includes("manage_members"))) throw new Error("Owner must retain membership administration");
  member.active = incoming.data.active;
  member.permissions = [...incoming.data.permissions];
  member.revision += 1;
}

// A member's status message ("working on X"). Members set their own;
// the owner may set anyone's. If memberId is omitted, the caller is the
// target. Bounded length, no HTML — rendered as text.
function updateMemberStatus(state, incoming) {
  requireFields(incoming.data, ["message"]);
  const targetId = incoming.data.memberId ?? incoming.actorId;
  const member = Object.hasOwn(state.members, targetId) && state.members[targetId];
  if (!member) throw new Error("Unknown member");
  if (incoming.actorId !== member.id && incoming.actorId !== state.room.ownerId) {
    throw new Error("Members may only set their own status message");
  }
  const message = String(incoming.data.message ?? "");
  if (message.length > 140) throw new Error("Status message must be 140 characters or fewer");
  member.statusMessage = message;
  member.revision += 1;
}

function requireScopedMemberAdministration(state, actorId, targetId, currentTarget, nextPermissions) {
  if (actorId === state.room.ownerId) return;
  if (targetId === state.room.ownerId) throw new Error("Only the Room owner may change owner authority");
  const actor = requireMember(state, actorId);
  const affected = new Set([...(currentTarget?.permissions ?? []), ...nextPermissions]);
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
  const proposal = proposalContext(incoming.data, state.workItems[incoming.data.workItemId]);
  if (incoming.data.replyToId && !state.messages.some(m => m.id === incoming.data.replyToId)) throw new Error("Reply must reference a message in this Room");
  if (state.messages.some(m => m.id === (incoming.data.messageId || incoming.id))) throw new Error("Message already exists");
  state.messages.push({
    id: incoming.data.messageId || incoming.id,
    authorId: actor.id,
    body: incoming.data.body,
    workItemId: incoming.data.workItemId || null,
    replyToId: incoming.data.replyToId || null,
    toMemberId: incoming.data.toMemberId || null,
    createdAt: incoming.at,
    ...(proposal ? { proposal } : {})
  });
  recordReplyPost(state, incoming, requestMode);
}

function setMessageReaction(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["messageId", "reaction", "active"]);
  const { messageId, reaction, active } = incoming.data;
  const message = state.messages.find(m => m.id === messageId);
  if (!message) throw new Error("Reaction must reference a message in this Room");
  if (!Object.hasOwn(REACTIONS, reaction) || typeof active !== "boolean") throw new Error("Invalid reaction choice");
  const members = new Set(message.reactions?.[reaction] || []);
  if (active) members.add(actor.id); else members.delete(actor.id);
  message.reactions ||= {};
  if (members.size) message.reactions[reaction] = [...members].sort();
  else delete message.reactions[reaction];
}

function proposeWork(state, incoming) {
  requirePermission(state, incoming.actorId, "steer");
  requireFields(incoming.data, ["workItemId", "title", "definitionOfDone", "accountableMemberId"]);
  if (state.workItems[incoming.data.workItemId]) throw new Error("Work Item already exists");
  requireMember(state, incoming.data.accountableMemberId);
  if (incoming.data.mode && !["read", "write"].includes(incoming.data.mode)) throw new Error("Invalid work mode");
  if (incoming.data.independentVerificationRequired && !incoming.data.verifierMemberId) throw new Error("Independent work requires a verifier");
  if (incoming.data.ownerDecisionRequired && !incoming.data.humanDecisionMakerId) throw new Error("Owner decision requires a decision-maker");
  if (incoming.data.verifierMemberId) requireMember(state, incoming.data.verifierMemberId);
  if (incoming.data.humanDecisionMakerId) {
    const decisionMaker = requireMember(state, incoming.data.humanDecisionMakerId);
    if (decisionMaker.kind !== "human") throw new Error("Decision-maker must be a human member");
  }
  if (incoming.data.independentVerificationRequired && incoming.data.accountableMemberId === incoming.data.verifierMemberId) {
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
    independentVerificationRequired: incoming.data.independentVerificationRequired === true,
    ownerDecisionRequired: incoming.data.ownerDecisionRequired === true,
    humanDecisionMakerId: incoming.data.humanDecisionMakerId || null,
    mode: incoming.data.mode || "read",
    sourceMessageId: incoming.data.sourceMessageId || null,
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
  commitMutation(member, incoming);
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
  let nativeText = null;
  if (incoming.data.evidenceKind === "room_text") {
    requireFields(incoming.data, ["summary", "evidenceVersion", "nextAction"]);
    nativeText = nativeTextEvidence(state, item, incoming.data);
  }
  else {
    if (["evidenceKind", "evidenceMessageId", "evidenceMessageEventId", "previousCompletionEventId"].some(key => Object.hasOwn(incoming.data, key))) throw new Error("Choose one evidence format");
    requireFields(incoming.data, ["summary", "evidenceUrl", "evidenceVersion", "nextAction"]);
    try {
      const url = new URL(incoming.data.evidenceUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch { throw new Error("Evidence must be an HTTPS URL without credentials"); }
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
    evidenceUrl: nativeText ? null : incoming.data.evidenceUrl,
    ...(nativeText ? { nativeText } : {}),
    evidenceVersion: incoming.data.evidenceVersion,
    checksClaimed: incoming.data.checksClaimed || [],
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
  requireFields(incoming.data, ["workItemId", "expectedRevision"]);
  const item = requireWorkItem(state, incoming.data.workItemId);
  if (!allowedStates.includes(item.state)) throw new Error(`Invalid transition from ${item.state}`);
  if (incoming.data.expectedRevision !== item.revision) throw new Error(`Stale Work Item revision: expected ${item.revision}`);
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
