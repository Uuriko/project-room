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
// The transport provider a preview is addressed to: synthetic samples are their
// own provider; channel sources name their connection's provider.
export const previewProvider = envelope => envelope.provider ?? envelope.adapter;
const label = p => p.displayName || p.handle || p.id;
export function sendPreview(accountId, authEpoch, source, data, draft) {
  if (!["synthetic", "telegram"].includes(data.adapter)) fail(409, "channel_sending_unavailable", "Sending is not enabled for this channel.");
  if (!draft || !draft.body.trim() || draft.source_revision !== source.revision)
    fail(409, "stale_inbox_reply", "Save a reply to the current source before sending.");
  const common = { accountId, authEpoch, sourceId: source.id, sourceRevision: source.revision, draftRevision: draft.revision };
  // Synthetic sources have one sender/recipient and no attachments. A real
  // adapter must qualify its own account, reply-to and attachment semantics.
  const envelope = data.adapter === "synthetic"
    ? { adapter: data.adapter, ...common, from: data.recipient, to: [data.sender], subject: data.subject, body: draft.body, attachments: [] }
    // Telegram replies go from the connected bot into the originating chat, as a
    // reply to the imported message. Fixture transport only; no Bot API call here.
    : { adapter: data.adapter, provider: data.envelope.connection.provider, ...common,
      from: label(data.envelope.connection.identity), to: [label(data.envelope.message.to[0])], subject: "", body: draft.body, attachments: [],
      target: { chatId: data.envelope.message.to[0].id, replyToMessageId: data.envelope.message.id.split(":")[1], threadId: data.envelope.message.threadId } };
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

// ---------------------------------------------------------------------------
// Direct channel-send outbox journal. Unlike the reply reserve/dispatch flow
// above (tied to an inbox source), a direct send is composed freely, so it gets
// its own additive table: pending → sent | failed. Message bodies are never
// stored or logged — only a SHA-256 hash for correlation. No network I/O here.

export const directSendChannels = Object.freeze(["gmail", "telegram"]);
// Exported so the store creates the table alongside the other additive
// schemas; the journal also ensures it lazily for raw-db callers.
export const directSendSchema = `CREATE TABLE IF NOT EXISTS direct_channel_sends (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, channel TEXT NOT NULL,
  recipient TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
  body_hash TEXT NOT NULL, thread_id TEXT,
  status TEXT NOT NULL, provider_id TEXT, error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;
const DIRECT_SEND_INDEX = `CREATE INDEX IF NOT EXISTS direct_channel_sends_account ON direct_channel_sends(account_id, created_at)`;
const ensureDirectSendTable = db => { db.exec(directSendSchema); db.exec(DIRECT_SEND_INDEX); };
const emailTo = v => typeof v === "string" && v.length >= 3 && v.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const chatTo = v => typeof v === "string" && /^-?\d{1,20}$/.test(v);
const directSendFields = data => data && typeof data === "object" && !Array.isArray(data)
  && (exact(data, ["channel", "to", "subject", "body"]) || exact(data, ["channel", "to", "subject", "body", "threadId"]));

export function validateDirectSend(data) {
  if (!directSendFields(data)) fail(422, "invalid_direct_send", "Send channel, recipient, subject and body.");
  if (!directSendChannels.includes(data.channel)) fail(422, "invalid_direct_send", "Send over gmail or telegram.");
  const toOk = data.channel === "gmail" ? emailTo(data.to) : chatTo(data.to);
  if (!toOk) fail(422, "invalid_direct_send", data.channel === "gmail" ? "A valid email recipient is required." : "A Telegram chat id is required.");
  if (typeof data.subject !== "string" || data.subject.length > 300) fail(422, "invalid_direct_send", "Subject must be at most 300 characters.");
  if (typeof data.body !== "string" || !data.body.trim() || data.body.length > 20000 || !data.body.isWellFormed())
    fail(422, "invalid_direct_send", "Message body must be 1–20000 characters.");
  if (data.channel === "telegram" && data.body.length > 4096) fail(422, "invalid_direct_send", "Telegram messages must be at most 4096 characters.");
  if (data.threadId !== undefined && !validId(data.threadId)) fail(422, "invalid_direct_send", "Thread reference is invalid.");
}

export function recordDirectSend(db, { id, accountId, channel, to, subject, bodyHash, threadId, at }) {
  ensureDirectSendTable(db);
  if (!validId(id) || !validId(accountId) || !directSendChannels.includes(channel) || typeof to !== "string" || !to
    || typeof bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(bodyHash) || !Number.isSafeInteger(at))
    fail(422, "invalid_direct_send", "Send channel, recipient and body are required.");
  db.prepare(`INSERT INTO direct_channel_sends
    (id, account_id, channel, recipient, subject, body_hash, thread_id, status, provider_id, error_code, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, accountId, channel, to, subject, bodyHash, threadId ?? null, "pending", null, null, at, at);
  return getDirectSend(db, id);
}

export function completeDirectSend(db, id, { status, providerId = null, errorCode = null, at }) {
  ensureDirectSendTable(db);
  if (!["sent", "failed"].includes(status) || !Number.isSafeInteger(at)) fail(422, "invalid_direct_send", "A send outcome is required.");
  const row = getDirectSend(db, id);
  if (!row) fail(404, "direct_send_not_found", "Send attempt not found.");
  if (row.status !== "pending") fail(409, "direct_send_settled", "This send attempt already settled.");
  db.prepare(`UPDATE direct_channel_sends SET status=?, provider_id=?, error_code=?, updated_at=? WHERE id=?`)
    .run(status, providerId, errorCode, at, id);
  return getDirectSend(db, id);
}

export function getDirectSend(db, id) {
  ensureDirectSendTable(db);
  const row = db.prepare(`SELECT * FROM direct_channel_sends WHERE id=?`).get(id);
  return row ?? null;
}

// The public shape: everything the owner may see, never the body.
export const publicDirectSend = row => row && {
  id: row.id, channel: row.channel, to: row.recipient, subject: row.subject,
  threadId: row.thread_id, status: row.status, providerId: row.provider_id,
  errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at
};
