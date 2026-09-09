import { validId } from "../src/events.js";
import { MAX_REPLY_REQUESTS, REPLY_POLICY_VERSION } from "../src/reply-requests.js";

// Metadata only. Use the same projection when producing a notice and validating
// its saved form, so a read pointer cannot become a suggested write on restart.
const fields = ["id", "openingEventId", "requesterId", "recipientId", "workItemId", "status", "revision", "contextEventId", "terminalEventId", "recipientAvailable"];
const nullableId = value => value === null || validId(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function validRequest(r) {
  return r && ["id", "openingEventId", "requesterId", "recipientId", "contextEventId"].every(key => validId(r[key]))
    && r.requesterId !== r.recipientId && nullableId(r.workItemId)
    && (r.status === "open" ? typeof r.recipientAvailable === "boolean" : r.recipientAvailable === null)
    && ["open", "answered", "declined", "cancelled"].includes(r.status)
    && r.revision === (r.status === "open" ? 0 : 1)
    && (r.status === "open" ? r.terminalEventId === null : validId(r.terminalEventId));
}
function conditionFor(r, memberId) {
  if (r.recipientId === memberId && r.status === "open") return "reply_requested";
  if (r.requesterId !== memberId) return null;
  if (["answered", "declined"].includes(r.status)) return r.status;
  return r.status === "open" && !r.recipientAvailable ? "recipient_unavailable" : null;
}
const titles = { reply_requested: "Reply requested", answered: "Reply available", declined: "Request declined", recipient_unavailable: "Recipient unavailable" };
const signatureFor = (r, condition) => JSON.stringify(["request", condition, ...fields.map(key => r[key])]);
const readFor = id => ({ tool: "room_read_request", arguments: { requestMessageId: id } });
const message = "Read the current exchange before responding. This notice does not accept work or grant permission.";
const noticeFields = ["schemaVersion", "type", "id", "reason", "observedAt", "evaluatedThrough", "subject", "roomId", "memberId", "request", "condition", "title", "notifyOnly", "message", "nextRead"];

export function hasRequestSupport(snapshot) {
  return snapshot?.replyRequestContractVersion === REPLY_POLICY_VERSION;
}

export function requestNotices(snapshot) {
  const requests = snapshot.state.replyRequests === undefined ? {} : snapshot.state.replyRequests, notices = new Map();
  if (!requests || typeof requests !== "object" || Array.isArray(requests) || Object.keys(requests).length > MAX_REPLY_REQUESTS) throw new Error("Invalid request snapshot");
  for (const [id, request] of Object.entries(requests)) {
    const recipient = snapshot.state.members[request?.recipientId], requester = snapshot.state.members[request?.requesterId];
    const r = Object.fromEntries(fields.map(key => [key, key === "recipientAvailable"
      ? request?.status === "open" ? recipient?.active !== false : null : request?.[key]]));
    if (r.id !== id || recipient?.id !== r.recipientId || requester?.id !== r.requesterId || !validRequest(r)) throw new Error("Invalid request snapshot");
    const condition = conditionFor(r, snapshot.viewerId);
    if (!condition) continue;
    notices.set(JSON.stringify(["request", id]), { signature: signatureFor(r, condition),
      payload: { subject: "request", roomId: snapshot.roomId, memberId: snapshot.viewerId,
        request: r, condition, title: titles[condition], notifyOnly: true,
        message, nextRead: readFor(id) } });
  }
  return notices;
}

export function validateRequestNotice(notice, signature, key, binding) {
  const r = notice.request;
  if (!validRequest(r) || !same(Object.keys(r).sort(), [...fields].sort())
      || !same(Object.keys(notice).sort(), [...noticeFields].sort()) || notice.message !== message
      || !notice.condition || notice.condition !== conditionFor(r, binding.memberId)
      || notice.title !== titles[notice.condition] || key !== JSON.stringify(["request", r.id])
      || JSON.stringify(signature) !== signatureFor(r, notice.condition) || !same(notice.nextRead, readFor(r.id))
      || ["next", "workItemId", "charter", "body"].some(key => Object.hasOwn(notice, key))) throw new Error("Invalid request notice");
}
