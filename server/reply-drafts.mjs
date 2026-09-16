// Agent reply drafts with owner approval (A024). A pure draft lifecycle:
// an agent's /draft-reply intent (A023) becomes a draft in
// "pending_approval"; only the room owner can approve or reject it; only an
// approved draft may be marked sent. Pure, dependency-free, deterministic;
// store persistence is a later slice. Malformed drafts are refused, never
// half-accepted.
import { randomUUID } from "node:crypto";

const STATUSES = ["pending_approval", "approved", "rejected", "sent"];
class DraftError extends Error { constructor(code, message) { super(message); this.name = "DraftError"; this.code = code; } }
const fail = (code, message) => { throw new DraftError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_draft", message); };

const text = (value, name, max) => {
  check(typeof value === "string" && value.trim().length > 0 && value.length <= max, `${name} must be non-empty text up to ${max} characters`);
  return value;
};
const idOf = value => (value === undefined ? randomUUID() : text(value, "id", 128));
const messageOf = value => checkDraftRef(value);

function checkDraftRef(draft) {
  check(draft !== null && typeof draft === "object" && !Array.isArray(draft), "draft must be an object");
  check(STATUSES.includes(draft.status), `draft status must be one of ${STATUSES.join(", ")}`);
  return draft;
}
const draftRecord = ({ id, status, messageId, authorAgentId, body, channel, connectionId, decidedBy, decisionReason, history }) =>
  Object.freeze({ id, status, messageId, authorAgentId, body, channel, connectionId,
    decidedBy: decidedBy ?? null, decisionReason: decisionReason ?? null,
    history: Object.freeze((history ?? []).map(h => Object.freeze({ ...h }))) });
const appendHistory = (draft, event) =>
  draftRecord({ ...draft, history: [...draft.history, Object.freeze({ ...event, at: new Date().toISOString() })] });

// Create a draft from an agent's /draft-reply intent. The draft is born in
// pending_approval and can never send itself.
export function createDraft({ id, messageId, authorAgentId, body, channel, connectionId }) {
  return appendHistory(draftRecord({
    id: idOf(id), status: "pending_approval", messageId: text(messageId, "messageId", 512),
    authorAgentId: text(authorAgentId, "authorAgentId", 128), body: text(body, "body", 50000),
    channel: text(channel, "channel", 64), connectionId: text(connectionId, "connectionId", 128),
  }), { type: "created" });
}
// Only the room owner (or the owner's delegated approver) may approve or
// reject. Rejections carry a reason so the authoring agent can revise.
export function decideDraft(draft, { decision, decidedBy, reason }) {
  const current = messageOf(draft);
  check(current.status === "pending_approval", "only pending_approval drafts can be decided");
  check(decision === "approve" || decision === "reject", 'decision must be "approve" or "reject"');
  const owner = text(decidedBy, "decidedBy", 128);
  const record = decision === "approve"
    ? draftRecord({ ...current, status: "approved", decidedBy: owner, decisionReason: null })
    : draftRecord({ ...current, status: "rejected", decidedBy: owner, decisionReason: text(reason, "reason", 2000) });
  return appendHistory(record, { type: decision === "approve" ? "approved" : "rejected", by: owner });
}
// Sending is the only terminal move from approved; the send itself happens
// in the provider lane, which calls this to close the loop.
export function markSent(draft, { sentMessageId }) {
  const current = messageOf(draft);
  check(current.status === "approved", "only approved drafts can be marked sent");
  return appendHistory(draftRecord({ ...current, status: "sent" }), { type: "sent", sentMessageId: text(sentMessageId, "sentMessageId", 512) });
}
// Read-only helpers for lists and counts.
export const draftStatus = draft => messageOf(draft).status;
export const pendingDrafts = drafts => {
  check(Array.isArray(drafts), "drafts must be a list");
  return drafts.filter(draft => messageOf(draft).status === "pending_approval");
};
export { DraftError, STATUSES };
