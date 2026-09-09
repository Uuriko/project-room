// Private send-intent state. No network I/O and no provider credentials live here.
import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const exact = (v, fields) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const revision = n => Number.isSafeInteger(n) && n >= 0;
export const isSend = request => typeof request?.action === "string" && request.action.startsWith("send.");
export const internalSend = request => ["send.dispatch", "send.observe"].includes(request?.action);
export function validateSend(request) {
  const common = ["action", "requestId", "sourceId"], fields = {
    "send.reserve": [...common, "sourceRevision", "draftRevision", "previewVersion"],
    "send.cancel": [...common, "sendId", "expectedRevision"],
    "send.dispatch": [...common, "sendId", "expectedRevision"],
    "send.observe": [...common, "sendId", "expectedRevision", "outcome", "providerId"]
  }[request?.action];
  if (!fields || !exact(request, fields) || !validId(request.requestId) || !validId(request.sourceId))
    fail(422, "invalid_inbox_send", "Choose an exact reply operation.");
  if (request.action === "send.reserve") {
    if (![request.sourceRevision, request.draftRevision].every(n => revision(n) && n > 0)
      || typeof request.previewVersion !== "string" || !/^[a-f0-9]{64}$/.test(request.previewVersion))
      fail(422, "invalid_inbox_send", "Review the saved reply before sending.");
  } else if (!validId(request.sendId) || !revision(request.expectedRevision)) {
    fail(422, "invalid_inbox_send", "Choose the current send attempt.");
  }
  if (request.action === "send.observe" && (!["accepted", "delivered", "rejected", "bounced"].includes(request.outcome)
    || (request.outcome === "rejected" ? request.providerId !== null : !validId(request.providerId))))
    fail(422, "invalid_inbox_send", "Supply a supported, correlated provider observation.");
}
export function sendPreview(accountId, authEpoch, source, data, draft) {
  if (data.adapter !== "synthetic") fail(409, "email_sending_unavailable", "Real email sending is not enabled.");
  if (!draft || !draft.body.trim() || draft.source_revision !== source.revision)
    fail(409, "stale_inbox_reply", "Save a reply to the current source before sending.");
  // Synthetic sources have one sender/recipient and no attachments. A real
  // adapter must qualify its own account, reply-to and attachment semantics.
  const envelope = { adapter: data.adapter, accountId, authEpoch, sourceId: source.id,
    sourceRevision: source.revision, draftRevision: draft.revision,
    from: data.recipient, to: [data.sender], subject: data.subject, body: draft.body, attachments: [] };
  const previewVersion = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
  return { ...envelope, previewVersion };
}
export function transitionSend(sends, request, { preview, authEpoch, at }) {
  const { action, sourceId } = request;
  if (action === "send.reserve") {
    if (!preview || request.sourceRevision !== preview.sourceRevision || request.draftRevision !== preview.draftRevision
      || request.previewVersion !== preview.previewVersion)
      fail(409, "stale_inbox_reply", "Reply or account changed. Review before sending.");
    for (const send of sends.values()) if (send.sourceId === sourceId) {
      if (["queued", "unknown"].includes(send.status)) fail(409, "inbox_send_unresolved", "Resolve the existing reply attempt first.");
      if (!["cancelled", "rejected"].includes(send.status) && send.envelope.draftRevision === preview.draftRevision
        && send.envelope.sourceRevision === preview.sourceRevision)
        fail(409, "inbox_reply_already_sent", "This saved reply already has a send attempt.");
    }
    return { id: request.requestId, sourceId, revision: 0, status: "queued", envelope: preview,
      providerId: null, createdAt: at, updatedAt: at };
  }
  const prior = sends.get(request.sendId);
  if (!prior || prior.sourceId !== sourceId) fail(404, "inbox_send_not_found", "Reply attempt not found.");
  if (prior.revision !== request.expectedRevision) fail(409, "stale_inbox_send", "Reply status changed. Check the existing attempt.");
  let status, providerId = prior.providerId;
  if (action === "send.cancel") {
    if (prior.status !== "queued") fail(409, "inbox_send_started", "Dispatch may have started. Check status instead of cancelling.");
    status = "cancelled";
  } else if (action === "send.dispatch") {
    if (prior.status !== "queued") fail(409, "inbox_send_started", "Do not dispatch an existing attempt again.");
    if (authEpoch !== prior.envelope.authEpoch || preview?.previewVersion !== prior.envelope.previewVersion)
      fail(409, "stale_inbox_reply", "Reply or authority changed. Cancel and review again.");
    // Persist uncertainty BEFORE leaving the transaction. A crash before or
    // after the external call must not make a second worker send again.
    status = "unknown";
  } else {
    const allowed = prior.status === "unknown" ? ["accepted", "delivered", "rejected"]
      : prior.status === "accepted" ? ["accepted", "delivered", "bounced"]
      : prior.status === "delivered" ? ["delivered"] : prior.status === "bounced" ? ["bounced"]
      : prior.status === "rejected" ? ["rejected"] : [];
    if (!allowed.includes(request.outcome) || (providerId !== null && providerId !== request.providerId))
      fail(409, "conflicting_inbox_observation", "Observation conflicts with the recorded attempt.");
    status = request.outcome; providerId = request.providerId;
  }
  return { ...prior, revision: prior.revision + 1, status, providerId, updatedAt: at };
}
