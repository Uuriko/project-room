import { WORK_STATES as S } from "./events.js";

export const producerKnown = item => item.receipt?.producerAttribution === "reported" && item.receipt.producerId != null;
export function matchesReceipt(record, receipt) {
  return Boolean(record && receipt?.eventId && receipt?.evidenceVersion
    && record.completionEventId === receipt.eventId && record.evidenceVersion === receipt.evidenceVersion);
}
export function verificationSatisfied(item) {
  if (!item.independentVerificationRequired) return true;
  const { receipt, verification } = item;
  return verification?.result === "pass" && verification.independenceConfirmed === true
    && verification.verifierId === item.verifierMemberId
    && matchesReceipt(verification, receipt)
    && producerKnown(item) && receipt.producerId !== verification.verifierId;
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
export function nextWorkStep(item) {
  const step = (action, label, memberId = null, role = null, needsAttention = false) => ({
    action, label, memberId, role, needsAttention,
    workItemId: item.id, workRevision: item.revision,
    completionEventId: item.receipt?.eventId ?? null,
    evidenceVersion: item.receipt?.evidenceVersion ?? null
  });
  const accountable = (action, label, attention = true) => step(action, label, item.accountableMemberId, "accountable", attention);
  if (item.state === S.SUPERSEDED || item.supersededBy) return step("superseded", "Continue in the replacement work item");
  if (item.state === S.PROPOSED) return accountable("accept", "Accept the assignment");
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
export function workStatus(item) {
  const next = nextWorkStep(item);
  const labels = {
    superseded: "Replaced", accept: "Awaiting acceptance", start: "Accepted",
    in_progress: "Working · reported", revise: "Blocked", unknown: "Needs reconciliation",
    provide_evidence: "Evidence missing", establish_provenance: "Producer unknown",
    resolve_independence: "Reviewer conflict", verify: "Awaiting verification",
    decide: "Awaiting decision", complete: "Completed"
  };
  return { label: labels[next.action], next: item.state === S.BLOCKED
    ? item.blocker?.nextAction || next.label : next.label, owner: next.memberId };
}
