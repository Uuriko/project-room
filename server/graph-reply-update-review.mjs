// Post-write inspection and review qualification. No provider I/O or send grant.
import { emailDigest, requireEmail } from "./email-envelope.mjs";
import { compareReplyUpdateEnvelope, compareReplyEnvelope, replyObservationReviewable } from "./graph-reply-draft.mjs";
import { ServiceError } from "./store.mjs";

const fail = (code, message) => { throw new ServiceError(409, code, message); };
const same = (a, b) => emailDigest(a) === emailDigest(b);
const identity = ({ accountId, id, provider, mailboxId }) => ({ accountId, id, provider, mailboxId });

export function buildUpdateInspection({ auth, source, connection, attempt, update }) {
  if (!update || !attempt || update.attemptId !== attempt.id || update.sourceId !== source.id)
    fail("reply_update_not_found", "Reply update not found.");
  if (!["update_unconfirmed", "update_acknowledged", "resolved"].includes(update.status))
    fail("reply_update_not_started", "No update has started.");
  if (connection?.mode !== "fixture" || connection.state !== "active" || connection.authEpoch !== auth.account.authEpoch
    || connection.profile.accountId !== auth.account.id
    || !same(identity(connection.profile), identity(update.proposal.connection)))
    fail("email_connection_changed", "Reconnect this mailbox before checking the update.");
  const context = { accountId: auth.account.id, authEpoch: auth.account.authEpoch,
    sourceId: source.id, sourceRevision: source.revision, attemptId: attempt.id, attemptRevision: attempt.revision,
    updateId: update.id, expectedRevision: update.revision, connection: connection.profile,
    acknowledgedDispatchId: update.acknowledgment?.dispatchRequestId ?? null };
  return { ...context, inspectionVersion: emailDigest(context) };
}

export function inspectUpdate(update, observation, context, requestId) {
  if (observation) requireEmail(same(observation.connection, context.connection), "email_reply_scope_changed");
  return {
    observation: compareReplyUpdateEnvelope({ ...update.proposal, connection: context.connection }, observation),
    inspection: { version: emailDigest({ requestId, context, observation }), authEpoch: context.authEpoch,
      sourceRevision: context.sourceRevision, attemptRevision: context.attemptRevision,
      connectionRevision: context.connection.revision, acknowledgedDispatchId: context.acknowledgedDispatchId }
  };
}

// Review is of an exact observed snapshot alongside today's saved local text.
// It neither adopts that text nor authorizes another write. expectedRevision is
// checked separately so recording a review does not invalidate its own basis.
export function buildUpdateReview(args) {
  const context = buildUpdateInspection(args), { update, draft } = args, i = update.inspection;
  const canReview = Boolean(update.acknowledgment && i?.acknowledgedDispatchId === update.acknowledgment.dispatchRequestId
    && i.authEpoch === context.authEpoch && i.sourceRevision === context.sourceRevision
    && i.attemptRevision === context.attemptRevision && i.connectionRevision === context.connection.revision
    && replyObservationReviewable({ ...update.observation, reviewVersion: i.version }));
  const { expectedRevision, inspectionVersion, ...basis } = context;
  return { accountId: context.accountId, authEpoch: context.authEpoch, updateId: update.id, canReview,
    sourceRevision: context.sourceRevision, draftRevision: draft?.revision ?? 0,
    reviewVersion: canReview ? emailDigest({ ...basis, inspection: i.version,
      draftRevision: draft?.revision ?? 0, draftBody: draft?.body ?? "" }) : null };
}

// The latest actual read, not a later acknowledgment carrying an older snapshot,
// supplies the next body-only proposal. Creation history remains untouched.
export function replyAttemptWithObservation(attempt, observation) {
  if (observation) requireEmail(same(identity(attempt.plan.connection), identity(observation.connection)), "email_reply_scope_changed");
  return { ...attempt, observation: compareReplyEnvelope({ ...attempt.plan,
    connection: observation?.connection ?? attempt.plan.connection }, attempt.providerDraftId, observation) };
}
