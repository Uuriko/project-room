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
