import { WORK_STATES as S } from "./events.js";

export const producerKnown = item => item.receipt?.producerAttribution === "reported" && item.receipt.producerId != null;
export function verificationSatisfied(item) {
  if (!item.independentVerificationRequired) return true;
  const { receipt, verification } = item;
  return verification?.result === "pass" && verification.independenceConfirmed === true
    && verification.verifierId === item.verifierMemberId
    && verification.completionEventId === receipt?.eventId
    && verification.evidenceVersion === receipt?.evidenceVersion
    && producerKnown(item) && receipt.producerId !== verification.verifierId;
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
  if (item.independentVerificationRequired && !producerKnown(item)) return accountable("establish_provenance", "Identify the producer before independent review");
  if (item.independentVerificationRequired && item.receipt.producerId === item.verifierMemberId) return accountable("resolve_independence", "Resolve the producer and reviewer conflict");
  if (!verificationSatisfied(item)) return step("verify", "Review the exact submitted version", item.verifierMemberId, "verifier", true);
  if (item.ownerDecisionRequired && !item.decision) return step("decide", "Review the evidence and make a decision", item.humanDecisionMakerId, "decision_maker", true);
  if (item.ownerDecisionRequired && item.decision?.decision !== "approved") return accountable("revise", "Resolve the outstanding decision");
  return step("complete", item.ownerDecisionRequired ? "Approved; this decision does not execute an external action" : "Recorded work complete; no further required check or decision");
}
