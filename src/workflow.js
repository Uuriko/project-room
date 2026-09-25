import { workProgress } from "./work-packet.js";
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

// Reusable work recipes (F7): the room's own recorded definitions offered as
// starting points for new work. Content only, like a reuse - never state,
// assignment, permission, result or source relationship. Most recently
// updated first, duplicates of the same definition collapsed, capped.
export function workRecipeOptions(workItems, { limit = 8, eventLog = [] } = {}) {
  if (!workItems || typeof workItems !== "object" || Array.isArray(workItems)) throw new Error("Work list unavailable");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid recipe limit");
  const seen = new Set(), recipes = [];
  const recordedOrder = new Map(eventLog.map((event, index) => [event.data?.workItemId, index]));
  const items = Object.values(workItems).sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? ""))
    || (recordedOrder.get(b?.id) ?? -1) - (recordedOrder.get(a?.id) ?? -1));
  for (const item of items) {
    let definition;
    try { definition = reusableWorkDefinition(item); } catch { continue; }
    const key = JSON.stringify([definition.title, definition.definitionOfDone]);
    if (seen.has(key)) continue;
    seen.add(key);
    recipes.push({ workItemId: item.id, ...definition });
    if (recipes.length >= limit) break;
  }
  return recipes;
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
    T.WORK_COMPLETED, T.CLAIM_ACQUIRED, T.CLAIM_RELEASED, T.CLAIM_RENEWED, T.VERIFICATION_RECORDED, T.OWNER_DECISION_RECORDED, T.WORK_HELP_UPDATED,
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
// `ownerId` is optional: an open handoff is triage addressed to the Room owner; the
// handoff record names that member itself, and `ownerId` only covers records that
// predate the field. Existing callers that omit it keep their previous result.
export function nextWorkStep(item, now = Date.now(), ownerId = null) {
  const step = (action, label, memberId = null, role = null, needsAttention = false) => ({
    action, label, memberId, role, needsAttention,
    workItemId: item.id, workRevision: item.revision,
    completionEventId: item.receipt?.eventId ?? null,
    evidenceVersion: item.receipt?.evidenceVersion ?? null
  });
  const accountable = (action, label, attention = true) => step(action, label, item.accountableMemberId, "accountable", attention);
  if (item.state === S.SUPERSEDED || item.supersededBy) return step("superseded", "Continue in the replacement work item");
  if (item.handoff?.open) return step("triaged_handoff", "Review the handoff", item.handoff.triageMemberId ?? ownerId ?? null, "owner", true);
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
    superseded: "Replaced", triaged_handoff: "Handoff open", accept: "Awaiting acceptance", start: "Accepted", claim: "Scope needed",
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
  if (claim) actions.push(["renew", "Renew scope"]);
  return actions;
}

const NEXT_ACTION = Object.freeze({
  accept: "accept",
  claim: "claim",
  start: "start",
  revise: "resolve",
  verify: "verify",
  decide: "decide",
  provide_evidence: "complete"
});

// One primary action from the current next step. Other actions stay available
// behind More. Release and renew stay on the scope record, not in this row.
export function presentedWorkActions(item, member, now = Date.now()) {
  const available = workActions(item, member, now).filter(([action]) => !["release", "renew"].includes(action));
  const next = nextWorkStep(item, now);
  const actionId = NEXT_ACTION[next.action] ?? null;
  const match = actionId ? available.find(([action]) => action === actionId) : null;
  if (!match) return { primary: null, more: available, nextAction: next.action, nextLabel: next.label };
  return {
    primary: { action: match[0], label: next.label },
    more: available.filter(([action]) => action !== match[0]),
    nextAction: next.action,
    nextLabel: next.label
  };
}

export function renderWorkActions(item, member, { now = Date.now(), busy = false, esc = value => String(value ?? ""), workId = item?.id } = {}) {
  const presented = presentedWorkActions(item, member, now);
  const button = (action, label, prominence) => `<button type="button" class="button ${prominence}" data-action="${esc(action)}" data-work-id="${esc(workId)}" data-focus-key="work-action:${esc(workId)}:${esc(action)}"${busy ? " disabled" : ""}>${esc(label)}</button>`;
  const primary = presented.primary ? button(presented.primary.action, presented.primary.label, "primary") : "";
  const moreButtons = presented.more.map(([action, label]) => button(action, label, "secondary")).join("");
  const more = moreButtons
    ? `<details class="work-more"><summary data-focus-key="work-more:${esc(workId)}">More</summary><div class="work-more-actions">${moreButtons}</div></details>`
    : "";
  return primary + more;
}

// Round-2 #117: done chip. Marks terminally finished work at a glance — a
// small chip distinct from the state badge, rendered on work cards and on
// message links that reference finished work. HTML-escaped by construction
// (no item fields interpolated).
export function doneChip(item) {
  if (!item || item.state === "superseded" || item.supersededBy) return "";
  return terminalWork(item) ? `<span class="done-chip" title="Finished and verified">✓ Done</span>` : "";
}

// F3: derived per-item change list from the item's own revision events.
// Read-time only: the event log is the record; this assigns each revision
// event the revision it produced (proposal is revision 0) so a viewer holding
// an older basis can see exactly what changed since. No new event types, so
// strict replay and historical recovery are unaffected.
const WORK_REVISION_TYPES_FOR_CHANGES = [
  T.WORK_ACCEPTED, T.WORK_STARTED, T.WORK_BLOCKED, T.WORK_BLOCKER_RESOLVED,
  T.WORK_COMPLETED, T.WORK_SUPERSEDED, T.CLAIM_ACQUIRED, T.CLAIM_RELEASED, T.CLAIM_RENEWED,
  T.VERIFICATION_RECORDED, T.OWNER_DECISION_RECORDED, T.DECISION_RECORDED,
  T.SESSION_STARTED, T.SESSION_STATUS_CHANGED, T.SESSION_STOP_REQUESTED, T.SESSION_STOPPED,
  T.WORK_HANDOFF_RECORDED
];
const WORK_CHANGE_TYPES = new Set([T.WORK_PROPOSED, ...WORK_REVISION_TYPES_FOR_CHANGES]);
export function workItemChanges(events) {
  if (!Array.isArray(events)) throw new Error("Work history must be a list");
  const changes = [];
  let revision = -1;
  for (const event of events) {
    if (!event || !WORK_CHANGE_TYPES.has(event.type)) continue;
    if (event.type === T.WORK_PROPOSED) revision = 0; else revision += 1;
    const data = event.data ?? {};
    changes.push({
      revision,
      type: event.type,
      actorId: event.actorId ?? null,
      at: event.at ?? null,
      ...(typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}),
      ...(typeof data.summary === "string" && data.summary ? { summary: data.summary } : {}),
      ...(typeof data.decision === "string" && data.decision ? { decision: data.decision } : {}),
      ...(typeof data.status === "string" && data.status ? { status: data.status } : {}),
      ...(typeof data.result === "string" && data.result ? { result: data.result } : {}),
      ...(typeof data.supersededBy === "string" && data.supersededBy ? { supersededBy: data.supersededBy } : {}),
      ...(data.claim && typeof data.claim === "object" ? { claim: { repository: data.claim.repository ?? "", ref: data.claim.ref ?? "" } } : {}),
      ...(typeof data.repository === "string" && data.repository ? { claim: { repository: data.repository, ref: typeof data.ref === "string" ? data.ref : "" } } : {})
    });
  }
  return changes;
}
export function changeDescription(entry) {
  switch (entry.type) {
    case T.WORK_PROPOSED: return "Work proposed";
    case T.WORK_ACCEPTED: return "Accepted";
    case T.WORK_STARTED: return "Work started";
    case T.WORK_BLOCKED: return entry.reason ? `Blocked: ${entry.reason}` : "Blocked";
    case T.WORK_BLOCKER_RESOLVED: return "Blocker resolved";
    case T.WORK_COMPLETED: return "Completion reported";
    case T.WORK_SUPERSEDED: return entry.supersededBy ? "Superseded by replacement work" : "Superseded";
    case T.CLAIM_ACQUIRED: return entry.claim?.repository ? `Scope claimed: ${entry.claim.repository}:${entry.claim.ref}` : "Scope claimed";
    case T.CLAIM_RELEASED: return "Scope released";
    case T.CLAIM_RENEWED: return "Scope renewed";
    case T.VERIFICATION_RECORDED: return entry.result ? `Verification: ${entry.result}` : "Verification recorded";
    case T.OWNER_DECISION_RECORDED:
    case T.DECISION_RECORDED: return entry.decision ? `Decision: ${entry.decision}` : "Decision recorded";
    case T.SESSION_STARTED: return "Native session started";
    case T.SESSION_STATUS_CHANGED: return entry.status ? `Native session: ${entry.status}` : "Native session updated";
    case T.SESSION_STOP_REQUESTED: return "Native session stop requested";
    case T.SESSION_STOPPED: return "Native session stopped";
    case T.WORK_HANDOFF_RECORDED: return "Handoff recorded";
    default: return "Updated";
  }
}

// F4: line comparison between a resubmitted native result and the exact
// previous version it names. Derived at read time; the versions themselves
// stay pinned by completion event + sha256. Oversized texts fail closed to a
// summary rather than pretending to compare.
const DIFF_LINE_LIMIT = 400;
export function diffResultLines(before, after) {
  if (typeof before !== "string" || typeof after !== "string") throw new Error("Compare exact result text");
  const a = before.split("\n"), b = after.split("\n");
  if (a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT) return null;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push({ type: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: "removed", text: a[i] }); i++; }
    else { rows.push({ type: "added", text: b[j] }); j++; }
  }
  while (i < m) rows.push({ type: "removed", text: a[i++] });
  while (j < n) rows.push({ type: "added", text: b[j++] });
  return rows;
}
export function diffResultSummary(rows) {
  const removed = rows.filter(row => row.type === "removed");
  const added = rows.filter(row => row.type === "added");
  const changedBytes = removed.concat(added).reduce((total, row) => total + row.text.length, 0);
  return { removedLines: removed.length, addedLines: added.length, changedBytes };
}

// One current-state restart record; no dispatch or history scan.
export function workResume(item, now = Date.now(), ownerId = null) {
  const next = nextWorkStep(item, now, ownerId);
  return { ...workProgress(item, now), next: { action: next.action, label: next.label, memberId: next.memberId } };
}
