import { EVENT_TYPES as T, WORK_STATES as S, validId, receiptHasKnownProducer, matchesReceipt, hasConfirmedIndependentPass } from "./events.js";

// Reuse content, never a prior assignment, permission, result or source relationship.
export function reusableWorkDefinition(work) {
  if (!work || typeof work !== "object" || Array.isArray(work)) throw new Error("Choose an existing work definition");
  const definition = {};
  for (const key of ["title", "definitionOfDone"]) {
    if (!Object.hasOwn(work, key) || typeof work[key] !== "string" || !work[key].trim() || work[key].length > 4096) throw new Error(`Invalid work ${key}`);
    definition[key] = work[key];
  }
  return definition;
}

// A parsed 2xx alone is not proof that this exact proposal was recorded.
export function confirmsWorkProposal(receipt, command, roomId, memberId) {
  const entry = receipt?.event, data = entry?.data;
  return Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0
    && typeof receipt.duplicate === "boolean" && validId(entry?.id)
    && entry.type === T.WORK_PROPOSED && command?.type === T.WORK_PROPOSED
    && entry.roomId === roomId && entry.actorId === memberId
    && data && Object.keys(data).length === Object.keys(command.data).length
    && Object.keys(command.data).every(key => Object.hasOwn(data, key) && data[key] === command.data[key]);
}

export { matchesReceipt };
export const producerKnown = item => receiptHasKnownProducer(item.receipt);
export function verificationSatisfied(item) {
  return !item.independentVerificationRequired || hasConfirmedIndependentPass(item);
}

export function currentApproval(item) {
  return item.state === S.COMPLETED && verificationSatisfied(item)
    && item.decision?.decision === "approved" && matchesReceipt(item.decision, item.receipt);
}
export function terminalWork(item) {
  if (item.state === S.SUPERSEDED || item.supersededBy) return true;
  return item.ownerDecisionRequired ? currentApproval(item)
    : item.state === S.COMPLETED && Boolean(item.receipt?.eventId && item.receipt?.evidenceVersion) && verificationSatisfied(item);
}

// A shared description for people and clients, never a grant or a dispatch command.
// In-progress work has an actor but does not create another attention request.
export function nextWorkStep(item, now = Date.now()) {
  const step = (action, label, memberId = null, role = null, needsAttention = false) => ({
    action, label, memberId, role, needsAttention,
    workItemId: item.id, workRevision: item.revision,
    completionEventId: item.receipt?.eventId ?? null,
    evidenceVersion: item.receipt?.evidenceVersion ?? null
  });
  const accountable = (action, label, attention = true) => step(action, label, item.accountableMemberId, "accountable", attention);
  if (item.state === S.SUPERSEDED || item.supersededBy) return step("superseded", "Continue in the replacement work item");
  if (item.state === S.PROPOSED) return accountable("accept", "Accept the assignment");
  if ([S.ACCEPTED, S.WORKING].includes(item.state) && item.mode === "write"
      && (!activeClaim(item, now) || item.claim.holderId !== item.accountableMemberId)) {
    return accountable("claim", "Confirm permission and reserve write scope");
  }
  if (item.state === S.ACCEPTED) return accountable("start", "Start the work");
  if (item.state === S.WORKING) return accountable("in_progress", "Work in progress; no new handoff yet", false);
  if (item.state === S.BLOCKED) return accountable("revise", "Resolve the blocker or revise the result");
  if (item.state !== S.COMPLETED) return step("unknown", "Work state needs reconciliation");
  if (!item.receipt?.eventId || !item.receipt?.evidenceVersion) return accountable("provide_evidence", "Provide a completion receipt");
  if (item.independentVerificationRequired && !producerKnown(item)) return accountable("establish_provenance", "Identify the producer before independent review");
  if (item.independentVerificationRequired && item.receipt.producerId === item.verifierMemberId) return accountable("resolve_independence", "Resolve the producer and reviewer conflict");
  if (!verificationSatisfied(item)) return step("verify", "Review the exact submitted version", item.verifierMemberId, "verifier", true);
  if (item.ownerDecisionRequired && !matchesReceipt(item.decision, item.receipt)) return step("decide", "Review the evidence and make a decision", item.humanDecisionMakerId, "decision_maker", true);
  if (item.ownerDecisionRequired && item.decision?.decision !== "approved") return accountable("revise", "Resolve the outstanding decision");
  return step("complete", item.ownerDecisionRequired ? "Approved; this decision does not execute an external action" : "Recorded work complete; no further required check or decision");
}

// PR20's presentation adapter delegates to the same next-step model as the API.
export function workStatus(item, now = Date.now()) {
  const next = nextWorkStep(item, now);
  const labels = {
    superseded: "Replaced", accept: "Awaiting acceptance", start: "Accepted", claim: "Scope needed",
    in_progress: "Working · reported", revise: "Blocked", unknown: "Needs reconciliation",
    provide_evidence: "Evidence missing", establish_provenance: "Producer unknown",
    resolve_independence: "Reviewer conflict", verify: "Awaiting verification",
    decide: "Awaiting decision", complete: "Completed"
  };
  return { label: labels[next.action], tone: next.action === "complete" ? "completed" : next.action === "revise" ? "blocked" : "pending", next: item.state === S.BLOCKED
    ? item.blocker?.nextAction || next.label : next.label, owner: next.memberId };
}

export const activeClaim = (item, now = Date.now()) => item.claim?.status === "active" && Date.parse(item.claim.expiresAt) > now;

// Presentation choices only. Every submitted action is still validated by the service.
export function workActions(item, member, now = Date.now()) {
  if (!member || member.active === false || item.state === S.SUPERSEDED || item.supersededBy) return [];
  const actions = [], own = item.accountableMemberId === member.id;
  const can = permission => member.permissions.includes(permission);
  const claim = activeClaim(item, now) && item.claim.holderId === member.id;
  const writable = item.mode === "read" || (claim && can("write_external"));
  if (own && item.state === S.PROPOSED && can("accept_work")) actions.push(["accept", "Accept"]);
  if (own && [S.ACCEPTED, S.WORKING, S.BLOCKED].includes(item.state) && item.mode === "write" && !activeClaim(item, now) && can("write_external")) actions.push(["claim", "Record write scope"]);
  if (own && item.state === S.ACCEPTED && can("accept_work") && writable) actions.push(["start", "Start"]);
  if (own && item.state === S.BLOCKED && can("accept_work")) actions.push(["resolve", "Resolve blocker"]);
  if (own && [S.ACCEPTED, S.WORKING].includes(item.state)) {
    if (can("accept_work")) actions.push(["block", "Report blocker"]);
    if (can("complete_work") && writable) actions.push(["complete", "Post evidence"]);
  }
  if (own && item.state === S.COMPLETED && can("accept_work")) actions.push(["block", "Reopen for rework"]);
  if (item.state === S.COMPLETED && item.receipt && member.id === item.verifierMemberId && can("verify")
    && (!item.independentVerificationRequired || (!own && (!producerKnown(item) || item.receipt.producerId !== member.id)))) {
    actions.push(["verify", item.verification ? "Review evidence again"
      : item.independentVerificationRequired && producerKnown(item) ? "Record independent check" : "Record evidence check"]);
  }
  if (nextWorkStep(item, now).action === "decide" && member.id === item.humanDecisionMakerId && member.kind === "human" && can("decide")) actions.push(["decide", "Record decision"]);
  if (activeClaim(item, now) && (claim || can("manage_claims"))) actions.push(["release", "Release scope"]);
  return actions;
}
