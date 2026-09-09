// Pure private reply-attempt transitions. No provider I/O or new storage engine.
import { validId } from "../src/events.js";
import { emailInput, emailOpaqueId, exactEmailFields } from "./email-envelope.mjs";
import { compareReplyEnvelope, compareReplyUpdateEnvelope } from "./graph-reply-draft.mjs";
import { ServiceError } from "./store.mjs";

const fail = (code, message, status = 409) => { throw new ServiceError(status, code, message); };
const revision = n => Number.isSafeInteger(n) && n >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const replyObservationBytes = 32768;
export const replyObservationReviewable = observation => Boolean(observation?.reviewVersion && observation.draft?.format === "text"
  && !observation.differences.some(value => ["draft_state", "thread", "from", "sender", "attachments"].includes(value))
  && (observation.draft.to.length || observation.draft.cc.length || observation.draft.bcc.length));
export const isReplyAttempt = request => typeof request?.action === "string" && request.action.startsWith("reply.");
export const isReplyUpdate = request => typeof request?.action === "string" && request.action.startsWith("reply.update.");
export const unresolvedReplyUpdate = (updates, attemptId) => [...updates.values()].some(update => update.attemptId === attemptId && update.status !== "cancelled");
export function validateReplyAttempt(request) {
  if (isReplyUpdate(request)) return validateReplyUpdate(request);
  emailInput(request);
  const common = ["action", "requestId", "sourceId"];
  const fields = {
    "reply.reserve": [...common, "mode", "planVersion"],
    "reply.cancel": [...common, "attemptId", "expectedRevision"],
    "reply.dispatch": [...common, "attemptId", "expectedRevision"],
    "reply.created": [...common, "attemptId", "expectedRevision", "planVersion", "providerDraftId"],
    "reply.observed": [...common, "attemptId", "expectedRevision", "observation"],
    "reply.review": [...common, "attemptId", "expectedRevision", "reviewVersion"]
  }[request?.action];
  if (!fields || !exactEmailFields(request, fields) || !validId(request.requestId) || !validId(request.sourceId))
    fail("invalid_reply_attempt", "Choose an exact reply operation.", 422);
  if (request.action === "reply.reserve") {
    if (!["reply", "replyAll"].includes(request.mode) || !hash(request.planVersion))
      fail("invalid_reply_attempt", "Review the saved reply first.", 422);
  } else if (!validId(request.attemptId) || !revision(request.expectedRevision))
    fail("invalid_reply_attempt", "Choose the current attempt.", 422);
  if (request.action === "reply.created") {
    if (!hash(request.planVersion)) fail("invalid_reply_attempt", "Choose the original reply plan.", 422);
    emailOpaqueId(request.providerDraftId);
  }
  if (request.action === "reply.review" && !hash(request.reviewVersion))
    fail("invalid_reply_review", "Choose the exact observed draft.", 422);
  if (request.action === "reply.observed" && (request.observation === undefined || Buffer.byteLength(JSON.stringify(request.observation)) > replyObservationBytes))
    fail("reply_observation_limit", "This draft is too large for the review pilot.", 422);
}

function validateReplyUpdate(request) {
  emailInput(request);
  if (request.action === "reply.update.acknowledged") {
    if (!exactEmailFields(request, ["action", "requestId", "sourceId", "attemptId", "updateId", "dispatchRequestId", "updateVersion", "providerDraftId", "providerRevision"])
      || ![request.requestId, request.sourceId, request.attemptId, request.updateId, request.dispatchRequestId].every(validId)
      || !hash(request.updateVersion))
      fail("invalid_reply_update", "Choose the exact dispatched update.", 422);
    emailOpaqueId(request.providerDraftId); emailOpaqueId(request.providerRevision);
    return;
  }
  const common = ["action", "requestId", "sourceId", "attemptId", "expectedRevision"];
  const fields = {
    "reply.update.reserve": [...common, "updateVersion"],
    "reply.update.cancel": [...common, "updateId"],
    "reply.update.dispatch": [...common, "updateId"],
    "reply.update.observed": [...common, "updateId", "observation"]
  }[request?.action];
  if (!fields || !exactEmailFields(request, fields) || ![request.requestId, request.sourceId, request.attemptId].every(validId)
    || !revision(request.expectedRevision) || (request.action === "reply.update.reserve" ? !hash(request.updateVersion) : !validId(request.updateId)))
    fail("invalid_reply_update", "Choose an exact reply update.", 422);
  if (request.action === "reply.update.observed" && (request.observation === undefined || Buffer.byteLength(JSON.stringify(request.observation)) > replyObservationBytes))
    fail("reply_observation_limit", "This draft is too large for the review pilot.", 422);
}

// Child evidence never mutates creation intent, the parent preview or local text.
export function transitionReplyUpdate(updates, request, { proposal, dispatch, at }) {
  validateReplyUpdate(request);
  if (!Number.isSafeInteger(at)) fail("invalid_reply_time", "Reply timestamp is unavailable.");
  if (request.action === "reply.update.reserve") {
    if (!proposal || proposal.requestId !== request.requestId || proposal.sourceId !== request.sourceId
      || proposal.attemptId !== request.attemptId || proposal.attemptRevision !== request.expectedRevision || proposal.updateVersion !== request.updateVersion)
      fail("stale_email_reply_update", "The reply changed. Compare it again.");
    if (proposal.status !== "update_proposed" || !proposal.update) fail("reply_update_not_needed", "The text already matches.");
    if (unresolvedReplyUpdate(updates, request.attemptId)) fail("reply_update_unresolved", "Check the existing update first.");
    return { id: request.requestId, sourceId: request.sourceId, attemptId: request.attemptId, revision: 0,
      status: "reserved", proposal: structuredClone(proposal), observation: null, dispatchedAt: null,
      createdAt: at, updatedAt: at, canExecute: false, canRetryUpdate: false, canReview: false, canSend: false };
  }
  const prior = updates.get(request.updateId);
  if (!prior || prior.sourceId !== request.sourceId || prior.attemptId !== request.attemptId)
    fail("reply_update_not_found", "Reply update not found.", 404);
  if (request.action === "reply.update.acknowledged") {
    // A write acknowledgment can arrive after newer reads. Bind it to the
    // immutable dispatch, not a stale child revision, and preserve those reads.
    if (prior.status !== "update_unconfirmed" || prior.acknowledgment
      || dispatch?.action !== "reply.update.dispatch" || dispatch.requestId !== request.dispatchRequestId
      || dispatch.sourceId !== prior.sourceId || dispatch.update?.id !== prior.id
      || dispatch.update.attemptId !== prior.attemptId || dispatch.update.status !== "update_unconfirmed"
      || dispatch.update.revision !== 1 || dispatch.update.dispatchedAt !== prior.dispatchedAt
      || JSON.stringify(dispatch.update.proposal) !== JSON.stringify(prior.proposal)
      || request.updateVersion !== prior.proposal.updateVersion || request.providerDraftId !== prior.proposal.providerDraftId)
      fail("conflicting_reply_update_acknowledgment", "The acknowledgment does not match this dispatched update.");
    return { ...prior, revision: prior.revision + 1, updatedAt: at, status: "update_acknowledged",
      acknowledgment: { dispatchRequestId: request.dispatchRequestId, updateVersion: request.updateVersion,
        providerDraftId: request.providerDraftId, providerRevision: request.providerRevision, at } };
  }
  if (prior.revision !== request.expectedRevision) fail("stale_reply_update", "Update status changed. Refresh it.");
  if (request.action === "reply.update.observed") {
    if (!["update_unconfirmed", "update_acknowledged"].includes(prior.status)) fail("reply_update_not_started", "No update has started.");
    return { ...prior, revision: prior.revision + 1, updatedAt: at,
      observation: compareReplyUpdateEnvelope(prior.proposal, request.observation) };
  }
  if (prior.status !== "reserved") fail("reply_update_started", "The update may have started. Check this attempt.");
  if (request.action === "reply.update.dispatch" && JSON.stringify(proposal) !== JSON.stringify(prior.proposal))
    fail("stale_email_reply_update", "The reply changed. Cancel and compare again.");
  return { ...prior, revision: prior.revision + 1, updatedAt: at,
    status: request.action === "reply.update.cancel" ? "cancelled" : "update_unconfirmed",
    dispatchedAt: request.action === "reply.update.dispatch" ? at : null };
}
export function transitionReplyAttempt(attempts, request, { plan, authEpoch, at }) {
  if (isReplyUpdate(request)) fail("invalid_reply_attempt", "Use the child update transition.", 422);
  validateReplyAttempt(request);
  if (!Number.isSafeInteger(at)) fail("invalid_reply_time", "Reply timestamp is unavailable.");
  if (request.action === "reply.reserve") {
    if (!plan || plan.sourceId !== request.sourceId || plan.requestId !== request.requestId
      || plan.mode !== request.mode || plan.planVersion !== request.planVersion)
      fail("stale_email_reply_plan", "The reply changed. Prepare it again.");
    for (const attempt of attempts.values()) if (attempt.sourceId === request.sourceId && attempt.status !== "cancelled")
      fail("email_reply_unresolved", "Resolve the existing mailbox draft attempt first.");
    return { id: request.requestId, sourceId: request.sourceId, revision: 0, status: "reserved", plan,
      providerDraftId: null, createdAt: at, updatedAt: at, canSend: false };
  }
  const prior = attempts.get(request.attemptId);
  if (!prior || prior.sourceId !== request.sourceId) fail("reply_attempt_not_found", "Reply attempt not found.", 404);
  if (prior.revision !== request.expectedRevision) fail("stale_reply_attempt", "Reply status changed. Refresh it.");
  let status, providerDraftId = prior.providerDraftId;
  if (request.action === "reply.cancel") {
    if (prior.status !== "reserved") fail("reply_creation_started", "Creation may have started. Check the existing attempt.");
    status = "cancelled";
  } else if (request.action === "reply.dispatch") {
    if (prior.status !== "reserved") fail("reply_creation_started", "Do not create this mailbox draft again.");
    if (plan?.planVersion !== prior.plan.planVersion) fail("stale_email_reply_plan", "Reply or authority changed. Cancel and review again.");
    // Commit BEFORE an external call; only the winning nonduplicate transition
    // may dispatch. A crash here remains uncertain, never automatically retryable.
    status = "creation_unconfirmed";
  } else if (request.action === "reply.created") {
    if (prior.status !== "creation_unconfirmed" || request.planVersion !== prior.plan.planVersion
      || request.providerDraftId === prior.plan.sourceMessageId)
      fail("conflicting_reply_observation", "The provider observation does not match this attempt.");
    for (const attempt of attempts.values()) if (attempt.id !== prior.id && attempt.providerDraftId === request.providerDraftId
      && attempt.plan.connection.provider === prior.plan.connection.provider
      && attempt.plan.connection.mailboxId === prior.plan.connection.mailboxId)
      fail("conflicting_reply_observation", "That mailbox draft already belongs to another attempt.");
    status = "created_unverified"; providerDraftId = request.providerDraftId;
  } else {
    if (!providerDraftId) fail("reply_draft_unconfirmed", "A confirmed mailbox draft identity is required.");
    if (!revision(authEpoch)) fail("invalid_reply_authority", "Current account authority is required.");
    let observation = prior.observation, review = prior.review ?? null;
    if (request.action === "reply.observed") {
      observation = compareReplyEnvelope(prior.plan, providerDraftId, request.observation);
      // Opaque provider versions are not sortable. expectedRevision was captured
      // before the read, so a late response cannot overwrite a newer observation.
      if (!observation.reviewVersion || review?.version !== observation.reviewVersion || review.authEpoch !== authEpoch) review = null;
    } else {
      if (plan?.planVersion !== prior.plan.planVersion)
        fail("stale_email_reply_plan", "Reply or authority changed. Review the current reply.");
      if (!observation?.reviewVersion || request.reviewVersion !== observation.reviewVersion)
        fail("stale_reply_review", "The mailbox draft changed. Review it again.");
      if (!replyObservationReviewable(observation))
        fail("unsupported_reply_review", "This draft needs a supported, complete mailbox preview.");
      review = { version: request.reviewVersion, accountId: plan.accountId, authEpoch, at };
    }
    status = review ? "draft_reviewed" : observation.status === "draft_unavailable" ? "draft_unavailable" : "awaiting_review";
    return { ...prior, revision: prior.revision + 1, status, observation, review, updatedAt: at };
  }
  return { ...prior, revision: prior.revision + 1, status, providerDraftId, updatedAt: at };
}
