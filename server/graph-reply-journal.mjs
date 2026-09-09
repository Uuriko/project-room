// Pure private reply-attempt transitions. No provider I/O or new storage engine.
import { validId } from "../src/events.js";
import { emailInput, emailOpaqueId, exactEmailFields } from "./email-envelope.mjs";
import { ServiceError } from "./store.mjs";

const fail = (code, message, status = 409) => { throw new ServiceError(status, code, message); };
const revision = n => Number.isSafeInteger(n) && n >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isReplyAttempt = request => typeof request?.action === "string" && request.action.startsWith("reply.");
export function validateReplyAttempt(request) {
  emailInput(request);
  const common = ["action", "requestId", "sourceId"];
  const fields = {
    "reply.reserve": [...common, "mode", "planVersion"],
    "reply.cancel": [...common, "attemptId", "expectedRevision"],
    "reply.dispatch": [...common, "attemptId", "expectedRevision"],
    "reply.created": [...common, "attemptId", "expectedRevision", "planVersion", "providerDraftId"]
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
}
export function transitionReplyAttempt(attempts, request, { plan, at }) {
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
  } else {
    if (prior.status !== "creation_unconfirmed" || request.planVersion !== prior.plan.planVersion
      || request.providerDraftId === prior.plan.sourceMessageId)
      fail("conflicting_reply_observation", "The provider observation does not match this attempt.");
    for (const attempt of attempts.values()) if (attempt.id !== prior.id && attempt.providerDraftId === request.providerDraftId
      && attempt.plan.connection.provider === prior.plan.connection.provider
      && attempt.plan.connection.mailboxId === prior.plan.connection.mailboxId)
      fail("conflicting_reply_observation", "That mailbox draft already belongs to another attempt.");
    status = "created_unverified"; providerDraftId = request.providerDraftId;
  }
  return { ...prior, revision: prior.revision + 1, status, providerDraftId, updatedAt: at };
}
