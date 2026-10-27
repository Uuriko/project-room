// Work lifecycle domain. The event coordinator owns ordering, deduplication
// and cloning; this module owns work transitions and their local invariants.
// Shared authority guards are injected once for identical replay/live behavior.
import { nativeTextEvidence, reportedProducer, validateResultSegments } from './work-packet.js';
import { applySessionFields } from './work-item-session.js';

export function createWorkReducers({ WORK_STATES, requirePermission, requireFields, requireMember, knownMember, receiptHasKnownProducer, requireWorkItem, assertRoomTrust, roomPolicy, claimIsActive, claimOverlaps, hasPermission, matchesReceipt, hasConfirmedIndependentPass, requirePublicDecisionSource }) {
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
  // A claim records scope. It does not grant write_external; write-mode
  // completion still requires that permission. Live commands admit only a
  // board writer (mayWriteBoardClaims). Replaying an older claim is unchanged.
  requireFields(incoming.data, ["repository", "ref", "paths", "expiresAt"]);
  if (!Array.isArray(incoming.data.paths) || incoming.data.paths.length === 0) throw new Error("Claim paths must be explicit");
  if (!Number.isFinite(Date.parse(incoming.data.expiresAt)) || Date.parse(incoming.data.expiresAt) <= Date.parse(incoming.at)) throw new Error("Claim expiry must be in the future");
  if (item.claim && claimIsActive(item.claim, incoming.at)) throw new Error("A current claim already exists");
  // Warn, never block: record which other active claims in this room already
  // hold one of these paths in the same repository. Live admission already
  // refuses an overlap on the same ref (server/claim-scopes.mjs); this catches
  // the cross-branch case, where two agents edit the same files on their own
  // branches and only collide at merge.
  const overlaps = claimOverlaps(state, item.id, incoming.data.repository, incoming.data.paths, incoming.at);
  item.claim = {
    holderId: incoming.actorId,
    repository: incoming.data.repository,
    ref: incoming.data.ref,
    paths: [...incoming.data.paths],
    acquiredAt: incoming.at,
    expiresAt: incoming.data.expiresAt,
    status: "active",
    ...(overlaps.length ? { overlaps } : {})
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

function renewClaim(state, incoming) {
  const item = mutableWorkItem(state, incoming, [WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED]);
  if (!item.claim || !claimIsActive(item.claim, incoming.at)) throw new Error("No active claim to renew — acquire a fresh claim instead");
  if (incoming.actorId !== item.claim.holderId) throw new Error("Only the claim holder may renew this claim");
  requireFields(incoming.data, ["expiresAt"]);
  if (!Number.isFinite(Date.parse(incoming.data.expiresAt)) || Date.parse(incoming.data.expiresAt) <= Date.parse(incoming.at)) throw new Error("Claim expiry must be in the future");
  if (incoming.data.progressMessageId != null) {
    requireProgressCheckin(state, item.claim, incoming.actorId, incoming.data.progressMessageId);
    item.claim.progressMessageId = incoming.data.progressMessageId;
  }
  item.claim.expiresAt = incoming.data.expiresAt;
  item.claim.renewedAt = incoming.at;
  item.claim.renewals = (item.claim.renewals ?? 0) + 1;
  commitMutation(item, incoming);
}

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

return Object.freeze({ proposeWork, acceptWork, startWork, blockWork, recordHandoff, clearHalt, resolveBlocker, completeWork, supersedeWork, acquireClaim, releaseClaim, renewClaim, recordVerification, applySession, recordOwnerDecision });
}
