export const EVENT_TYPES = Object.freeze({
  ROOM_CREATED: "room.created",
  MEMBER_ADDED: "member.added",
  MESSAGE_POSTED: "message.posted",
  WORK_PROPOSED: "work.proposed",
  WORK_ACCEPTED: "work.accepted",
  WORK_STARTED: "work.started",
  WORK_BLOCKED: "work.blocked",
  WORK_BLOCKER_RESOLVED: "work.blocker_resolved",
  WORK_COMPLETED: "work.completed",
  WORK_SUPERSEDED: "work.superseded",
  CLAIM_ACQUIRED: "claim.acquired",
  CLAIM_RELEASED: "claim.released",
  VERIFICATION_RECORDED: "verification.recorded",
  OWNER_DECISION_RECORDED: "owner.decision_recorded"
});

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
    [EVENT_TYPES.MEMBER_ADDED]: addMember,
    [EVENT_TYPES.MESSAGE_POSTED]: postMessage,
    [EVENT_TYPES.WORK_PROPOSED]: proposeWork,
    [EVENT_TYPES.WORK_ACCEPTED]: acceptWork,
    [EVENT_TYPES.WORK_STARTED]: startWork,
    [EVENT_TYPES.WORK_BLOCKED]: blockWork,
    [EVENT_TYPES.WORK_BLOCKER_RESOLVED]: resolveBlocker,
    [EVENT_TYPES.WORK_COMPLETED]: completeWork,
    [EVENT_TYPES.WORK_SUPERSEDED]: supersedeWork,
    [EVENT_TYPES.CLAIM_ACQUIRED]: acquireClaim,
    [EVENT_TYPES.CLAIM_RELEASED]: releaseClaim,
    [EVENT_TYPES.VERIFICATION_RECORDED]: recordVerification,
    [EVENT_TYPES.OWNER_DECISION_RECORDED]: recordOwnerDecision
  };
  const handler = handlers[incoming.type];
  if (!handler) throw new Error(`Unsupported event type: ${incoming.type}`);
  handler(state, incoming);

  state.eventLog.push(incoming);
  state.seenEvents[incoming.id] = fingerprint;
  state.seenIdempotencyKeys[incoming.idempotencyKey] = incoming.id;
  return state;
}

function validateEnvelope(incoming) {
  for (const key of ["id", "idempotencyKey", "roomId", "type", "actorId", "at"]) {
    if (!incoming?.[key]) throw new Error(`Event missing ${key}`);
  }
  if (Number.isNaN(Date.parse(incoming.at))) throw new Error("Event at must be an ISO date");
}

function createRoom(state, incoming) {
  if (state.room) throw new Error("Room already exists");
  requireFields(incoming.data, ["roomId", "title", "purpose", "ownerId"]);
  if (incoming.roomId !== incoming.data.roomId) throw new Error("Room event id mismatch");
  state.room = { id: incoming.data.roomId, ...incoming.data, createdAt: incoming.at };
}

function addMember(state, incoming) {
  requireFields(incoming.data, ["memberId", "displayName", "kind", "permissions"]);
  const memberId = incoming.data.memberId;
  if (state.members[memberId]) throw new Error("Member already exists");
  const isBootstrapOwner = Object.keys(state.members).length === 0 && memberId === state.room.ownerId;
  if (!isBootstrapOwner) requirePermission(state, incoming.actorId, "manage_members");
  state.members[memberId] = {
    id: memberId,
    displayName: incoming.data.displayName,
    kind: incoming.data.kind,
    accountableHumanId: incoming.data.accountableHumanId || (incoming.data.kind === "human" ? memberId : state.room.ownerId),
    permissions: [...incoming.data.permissions],
    availability: incoming.data.availability || "available"
  };
}

function postMessage(state, incoming) {
  const actor = requireMember(state, incoming.actorId);
  requireFields(incoming.data, ["body"]);
  if (incoming.data.toMemberId) requireMember(state, incoming.data.toMemberId);
  state.messages.push({
    id: incoming.data.messageId || incoming.id,
    authorId: actor.id,
    body: incoming.data.body,
    workItemId: incoming.data.workItemId || null,
    replyToId: incoming.data.replyToId || null,
    toMemberId: incoming.data.toMemberId || null,
    createdAt: incoming.at
  });
}

function proposeWork(state, incoming) {
  requirePermission(state, incoming.actorId, "steer");
  requireFields(incoming.data, ["workItemId", "title", "definitionOfDone", "accountableMemberId"]);
  if (state.workItems[incoming.data.workItemId]) throw new Error("Work Item already exists");
  requireMember(state, incoming.data.accountableMemberId);
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
  if (item.state === WORK_STATES.BLOCKED) requireFields(incoming.data, ["resolvedBlocker"]);
  if (item.mode === "write" && (!item.claim || !claimIsActive(item.claim, incoming.at) || item.claim.holderId !== incoming.actorId)) {
    throw new Error("Contested writes require a current exact-scope claim");
  }
  item.state = WORK_STATES.WORKING;
  item.blocker = null;
  commitMutation(item, incoming);
}

function blockWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.COMPLETED]);
  const isAccountable = incoming.actorId === item.accountableMemberId;
  const isVerifierOnCompletion = item.state === WORK_STATES.COMPLETED && incoming.actorId === item.verifierMemberId;
  if (!isAccountable && !isVerifierOnCompletion) throw new Error("Only the accountable member or completed-work verifier may block work");
  requireFields(incoming.data, ["reason", "nextAction"]);
  item.state = WORK_STATES.BLOCKED;
  item.blocker = { reason: incoming.data.reason, nextAction: incoming.data.nextAction, eventId: incoming.id };
  commitMutation(item, incoming);
}

function resolveBlocker(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.BLOCKED]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may resolve the blocker");
  requireFields(incoming.data, ["resolution"]);
  item.state = WORK_STATES.ACCEPTED;
  item.blocker = null;
  commitMutation(item, incoming);
}

function completeWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING]);
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may report completion");
  requirePermission(state, incoming.actorId, "complete_work");
  requireFields(incoming.data, ["summary", "evidenceUrl", "evidenceVersion", "nextAction"]);
  if (item.receipt) item.receiptHistory.push(item.receipt);
  if (item.verification) item.verificationHistory.push(item.verification);
  if (item.decision) item.decisionHistory.push(item.decision);
  item.receipt = {
    producerId: incoming.actorId,
    summary: incoming.data.summary,
    evidenceUrl: incoming.data.evidenceUrl,
    evidenceVersion: incoming.data.evidenceVersion,
    checksClaimed: incoming.data.checksClaimed || [],
    nextAction: incoming.data.nextAction,
    eventId: incoming.id
  };
  item.verification = null;
  item.decision = null;
  item.blocker = null;
  item.state = WORK_STATES.COMPLETED;
  commitMutation(item, incoming);
}

function supersedeWork(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.PROPOSED, WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED, WORK_STATES.COMPLETED]);
  requirePermission(state, incoming.actorId, "steer");
  requireFields(incoming.data, ["supersededByWorkItemId", "reason"]);
  if (!state.workItems[incoming.data.supersededByWorkItemId]) throw new Error("Replacement Work Item must exist");
  item.state = WORK_STATES.SUPERSEDED;
  item.supersededBy = incoming.data.supersededByWorkItemId;
  commitMutation(item, incoming);
}

function acquireClaim(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED]);
  if (item.mode !== "write") throw new Error("Read-only work does not use a write claim");
  if (incoming.actorId !== item.accountableMemberId) throw new Error("Only the accountable member may acquire this claim");
  requirePermission(state, incoming.actorId, "write_external");
  requireFields(incoming.data, ["repository", "ref", "paths", "expiresAt"]);
  if (!Array.isArray(incoming.data.paths) || incoming.data.paths.length === 0) throw new Error("Claim paths must be explicit");
  if (Date.parse(incoming.data.expiresAt) <= Date.parse(incoming.at)) throw new Error("Claim expiry must be in the future");
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
  const matchesCurrentReceipt =
    incoming.data.completionEventId === item.receipt?.eventId &&
    incoming.data.evidenceVersion === item.receipt?.evidenceVersion;
  const matchesHistoricalReceipt = item.receiptHistory.some((receipt) =>
    incoming.data.completionEventId === receipt.eventId &&
    incoming.data.evidenceVersion === receipt.evidenceVersion
  );
  if (!matchesCurrentReceipt && !matchesHistoricalReceipt) {
    throw new Error("Verification must identify the exact current completion and evidence version");
  }
  if (!["pass", "fail"].includes(incoming.data.result)) throw new Error("Verification result must be pass or fail");

  const verification = {
    verifierId: incoming.actorId,
    result: incoming.data.result,
    completionEventId: incoming.data.completionEventId,
    evidenceVersion: incoming.data.evidenceVersion,
    summary: incoming.data.summary,
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
    item.state = WORK_STATES.BLOCKED;
    item.blocker = {
      reason: incoming.data.summary,
      nextAction: incoming.data.nextAction || "Accountable member addresses the finding",
      eventId: incoming.id
    };
  }
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
  if (incoming.data.completionEventId !== item.receipt?.eventId || incoming.data.evidenceVersion !== item.receipt?.evidenceVersion) {
    throw new Error("Decision must identify the exact current completion and evidence version");
  }
  if (incoming.data.decision === "approved" && item.independentVerificationRequired && item.verification?.result !== "pass") {
    throw new Error("Approval requires the designated independent PASS");
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

function claimIsActive(claim, at) {
  return claim.status === "active" && Date.parse(claim.expiresAt) > Date.parse(at);
}

function requireMember(state, memberId) {
  const member = state.members[memberId];
  if (!member) throw new Error(`Unknown member: ${memberId}`);
  return member;
}

function requireWorkItem(state, workItemId) {
  const item = state.workItems[workItemId];
  if (!item) throw new Error(`Unknown Work Item: ${workItemId}`);
  return item;
}

function requirePermission(state, memberId, permission) {
  if (!hasPermission(state, memberId, permission)) throw new Error(`${memberId} lacks ${permission}`);
}

function hasPermission(state, memberId, permission) {
  return requireMember(state, memberId).permissions.includes(permission);
}

function requireFields(data, fields) {
  for (const field of fields) {
    if (data?.[field] === undefined || data?.[field] === null || data?.[field] === "") {
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
