import { WORK_STATES as S } from "./events.js";

// Shared by the return selectors and UI. Old projections may still contain a
// decision after reopening; only the current completed receipt can close work.
export function matchesReceipt(record, receipt) {
  return Boolean(record && receipt?.eventId && receipt?.evidenceVersion &&
    record.completionEventId === receipt.eventId && record.evidenceVersion === receipt.evidenceVersion);
}
export function verificationSatisfied(item) {
  return !item.independentVerificationRequired ||
    (item.verification?.result === "pass" && matchesReceipt(item.verification, item.receipt));
}
export function currentApproval(item) {
  return item.state === S.COMPLETED && verificationSatisfied(item) &&
    item.decision?.decision === "approved" && matchesReceipt(item.decision, item.receipt);
}
export function terminalWork(item) {
  if (item.supersededBy || item.state === S.SUPERSEDED) return true;
  if (item.ownerDecisionRequired) return currentApproval(item);
  return item.state === S.COMPLETED && Boolean(item.receipt) && verificationSatisfied(item);
}

// Describe recorded work, never infer execution from transport or notification state.
export function workStatus(item) {
  if (item.supersededBy || item.state === S.SUPERSEDED)
    return { label: "Replaced", next: "Continue with the replacement work item.", owner: item.accountableMemberId };
  if (item.state === S.BLOCKED)
    return { label: "Blocked", next: item.blocker?.nextAction || "Record the next step to unblock this work.", owner: item.accountableMemberId };
  if (item.state === S.COMPLETED) {
    if (!item.receipt) return { label: "Evidence missing", next: "Provide a completion receipt.", owner: item.accountableMemberId };
    if (!verificationSatisfied(item)) return { label: "Awaiting verification", next: "Review the submitted evidence.", owner: item.verifierMemberId };
    if (item.ownerDecisionRequired && !currentApproval(item))
      return { label: "Awaiting decision", next: "Record a decision on this completion.", owner: item.humanDecisionMakerId };
    return { label: "Completed", next: item.receipt.nextAction || "No further action recorded.", owner: null };
  }
  if (item.state === S.WORKING)
    return { label: "Working · reported", next: "Post evidence when finished, or report a blocker.", owner: item.accountableMemberId };
  if (item.state === S.ACCEPTED)
    return { label: "Accepted", next: "Start the work or report a blocker.", owner: item.accountableMemberId };
  return { label: "Awaiting acceptance", next: "Accept this work to begin.", owner: item.accountableMemberId };
}
