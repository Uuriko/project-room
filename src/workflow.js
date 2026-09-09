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

// A conversational offer on selected work, never open assignment or capability
// matching. Derive from committed participant/work facts; do not inspect prose.
export function workCollaboration(item, member, participants) {
  const accountable = participants.find(person => person.id === item.accountableMemberId);
  const status = member.active !== true ? "unavailable"
    : item.state === S.COMPLETED || terminalWork(item) ? "closed"
    : member.id === item.accountableMemberId ? "accountable"
    : item.independentVerificationRequired && member.id === item.verifierMemberId ? "independent_reviewer"
    : accountable?.active !== true ? "unavailable" : "may_offer";
  return { version: 1, status, offer: status === "may_offer" ? {
    checkExisting: { tool: "room_list_requests", arguments: { direction: "outgoing", status: "all" } },
    readDiscussion: { tool: "room_read_work_discussion", arguments: { workItemId: item.id } },
    request: { tool: "room_request_reply", arguments: { workItemId: item.id, toMemberId: accountable.id }, requiredInput: ["requestId", "body"] },
    guidance: "Not a help-wanted listing. Follow your operator's instructions; inspect discussion and your previous requests before offering one bounded contribution. An answer does not assign work or grant external permission. Do not repeat declined offers."
  } : null };
}

// Work actions can carry arrays. Exact payload and business-operation identity
// must match before a browser may discard a retained retry or announce success.
export async function confirmsWorkAction(receipt, command, roomId, memberId) {
  const entry = receipt?.event;
  const actions = [T.WORK_ACCEPTED, T.WORK_STARTED, T.WORK_BLOCKED, T.WORK_BLOCKER_RESOLVED,
    T.WORK_COMPLETED, T.CLAIM_ACQUIRED, T.CLAIM_RELEASED, T.VERIFICATION_RECORDED, T.OWNER_DECISION_RECORDED, T.WORK_HELP_UPDATED,
    T.HELP_OFFER_OPENED, T.HELP_OFFER_UPDATED];
  const same = (a, b) => a === b || (a && b && typeof a === "object" && typeof b === "object"
    && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key])));
  if (!actions.includes(command?.type) || !validId(command?.id) || !Number.isSafeInteger(receipt?.sequence) || receipt.sequence < 1
    || typeof receipt.duplicate !== "boolean" || !validId(entry?.id) || entry.type !== command.type
    || entry.roomId !== roomId || entry.actorId !== memberId || entry.causationId !== (command.causationId ?? null)
    || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))
    || !command.data || typeof command.data !== "object" || Array.isArray(command.data) || !same(entry.data, command.data)) return false;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${memberId}:${command.id}`));
    return entry.idempotencyKey === [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { return false; }
}
// The same packet may have several drafts: its stable message ID distinguishes
// this submission. Current return commands contain only primitive data fields.
export function confirmsWorkReturn(receipt, command, roomId, memberId) {
  const entry = receipt?.event, data = entry?.data, expected = command?.data;
  return Boolean(Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0
    && typeof receipt.duplicate === "boolean" && validId(entry?.id)
    && entry.type === T.MESSAGE_POSTED && command?.type === T.MESSAGE_POSTED
    && entry.roomId === roomId && entry.actorId === memberId
    && validId(expected?.messageId) && data && !Array.isArray(data)
    && Object.keys(data).length === Object.keys(expected).length
    && Object.keys(expected).every(key => Object.hasOwn(data, key) && data[key] === expected[key]));
}

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
  if (item.independentVerificationRequired && !producerKnown(item)) return accountable("establish_provenance", item.receipt.producerAttribution === "external-reported"
    ? "Confirm producer identity before independent review" : "Identify the producer before independent review");
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
  return { label: next.action === "establish_provenance" && item.receipt?.producerAttribution === "external-reported" ? "Outside credit" : labels[next.action], tone: next.action === "complete" ? "completed" : next.action === "revise" ? "blocked" : "pending", next: item.state === S.BLOCKED
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
