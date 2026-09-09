import { createHash } from "node:crypto";
import { validId, EVENT_TYPES as T, hasConfirmedIndependentPass } from "../src/events.js";
import { currentApproval } from "../src/workflow.js";
import { storedText } from "./text-results.mjs";
import { ServiceError } from "./store.mjs";
import { isSend, internalSend, validateSend, sendPreview, transitionSend } from "./inbox-outbox.mjs";
import { readEmailEnvelope, EmailContractError } from "./email-envelope.mjs";
import { prepareGraphReplyDraft, buildGraphReplyDraft, classifyGraphReplyCreation, classifyGraphReplyUpdateAcknowledgment, normalizeReplyObservation, prepareGraphReplyUpdate, buildGraphReplyUpdate } from "./graph-reply-draft.mjs";
import { isReplyAttempt, validateReplyAttempt, transitionReplyAttempt, replyObservationReviewable, isReplyUpdate, transitionReplyUpdate, unresolvedReplyUpdate } from "./graph-reply-journal.mjs";

const transportAuthority = Symbol("private inbox transport");
const importAuthority = Symbol("private email importer");
const replyAuthority = Symbol("private fixture reply driver");

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : value && typeof value === "object"
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const exact = (v, fields) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(f => Object.hasOwn(v, f));
const revision = n => Number.isSafeInteger(n) && n >= 0;
const isShare = request => ["source.share", "source.excerpt"].includes(request.action);
const emailSelectionText = body => body.content.replace(/\r\n?/g, "\n");
const text = (v, max, empty = false) => typeof v === "string" && v.isWellFormed() && v.length <= max && (empty || v.trim().length > 0);
const same = (a, b) => canonical(a) === canonical(b);
export const inboxLimits = Object.freeze({ sources: 100, versions: 100, commands: 5000, paragraphs: 20 });
export const inboxSchema = `
  CREATE TABLE private_inbox_sources (
    account_id TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id,id)
  );
  CREATE TABLE private_inbox_versions (
    account_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(account_id,source_id,revision),
    FOREIGN KEY(account_id,source_id) REFERENCES private_inbox_sources(account_id,id)
  );
  CREATE TABLE private_inbox_drafts (
    account_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    source_revision INTEGER NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,source_id), FOREIGN KEY(account_id,source_id,source_revision) REFERENCES private_inbox_versions(account_id,source_id,revision)
  );
  CREATE TABLE private_inbox_commands (
    sequence INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), auth_epoch INTEGER NOT NULL, at INTEGER NOT NULL,
    UNIQUE(account_id,request_id)
  );
  CREATE TRIGGER private_inbox_versions_no_update BEFORE UPDATE ON private_inbox_versions BEGIN SELECT RAISE(ABORT,'source versions are immutable'); END;
  CREATE TRIGGER private_inbox_versions_no_delete BEFORE DELETE ON private_inbox_versions BEGIN SELECT RAISE(ABORT,'source versions are retained'); END;
  CREATE TRIGGER private_inbox_commands_no_update BEFORE UPDATE ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'inbox receipts are immutable'); END;
  CREATE TRIGGER private_inbox_commands_no_delete BEFORE DELETE ON private_inbox_commands BEGIN SELECT RAISE(ABORT,'inbox receipts are retained'); END;
`;
function validate(request) {
  if (isReplyAttempt(request)) return validateReplyAttempt(request);
  if (isSend(request)) return validateSend(request);
  const common = ["requestId", "action", "sourceId"], fields = {
    "source.save": [...common, "expectedRevision", "data"],
    "source.import": [...common, "expectedRevision", "data"],
    "draft.save": [...common, "expectedRevision", "sourceRevision", "body"],
    "draft.adopt": [...common, "expectedRevision", "sourceRevision", "roomId", "workItemId", "shareRequestId", "resultVersion"],
    "source.share": [...common, "sourceRevision", "roomId", "audienceVersion", "paragraphs"],
    "source.excerpt": [...common, "sourceRevision", "roomId", "audienceVersion", "selection"]
  }[request?.action];
  if (!fields || !exact(request, fields) || !validId(request.requestId) || !validId(request.sourceId))
    fail(422, "invalid_inbox_request", "Supply an exact inbox operation and stable request ID.");
  if (!isShare(request) && !revision(request.expectedRevision)) fail(422, "invalid_inbox_request", "Current revision required.");
  if (!["source.save", "source.import"].includes(request.action) && (!revision(request.sourceRevision) || !request.sourceRevision)) fail(422, "invalid_inbox_request", "Source revision required.");
  if (request.action === "source.import") {
    if (!exact(request.data, ["adapter", "envelope"]) || request.data.adapter !== "email") fail(422, "invalid_inbox_source", "Supply a qualified email observation.");
    let envelope;
    try { envelope = readEmailEnvelope(request.data.envelope); }
    catch (error) { if (error instanceof EmailContractError) fail(422, "invalid_inbox_source", "Email observation could not be confirmed."); throw error; }
    if (envelope.sourceId !== request.sourceId) fail(422, "invalid_inbox_source", "Source identity does not match the email observation.");
  }
  if (request.action === "source.save") {
    const d = request.data;
    if (!exact(d, ["adapter", "sender", "recipient", "subject", "paragraphs"]) || d.adapter !== "synthetic"
      || !["sender", "recipient", "subject"].every(k => text(d[k], 240))
      || !Array.isArray(d.paragraphs) || !d.paragraphs.length || d.paragraphs.length > inboxLimits.paragraphs
      || !d.paragraphs.every(p => text(p, 4000)) || new TextEncoder().encode(JSON.stringify(d)).length > 12000)
      fail(422, "invalid_inbox_source", "Supply a bounded synthetic source, not a provider connection.");
  }
  if (request.action === "draft.save" && !text(request.body, 4000, true)) fail(422, "invalid_inbox_draft", "Draft must be well-formed text up to 4,000 characters.");
  if (request.action === "draft.adopt" && (![request.roomId, request.workItemId, request.shareRequestId].every(validId)
    || typeof request.resultVersion !== "string" || !/^[a-f0-9]{64}$/.test(request.resultVersion)))
    fail(422, "invalid_inbox_result", "Choose an exact reviewed room result.");
  if (request.action === "source.share" && (!validId(request.roomId) || typeof request.audienceVersion !== "string" || !/^[a-f0-9]{64}$/.test(request.audienceVersion)
    || !Array.isArray(request.paragraphs) || !request.paragraphs.length || request.paragraphs.length > inboxLimits.paragraphs
    || !request.paragraphs.every(n => revision(n) && n < inboxLimits.paragraphs) || new Set(request.paragraphs).size !== request.paragraphs.length))
    fail(422, "invalid_inbox_share", "Select source paragraphs and the current room audience.");
  if (request.action === "source.excerpt" && (!validId(request.roomId) || typeof request.audienceVersion !== "string" || !/^[a-f0-9]{64}$/.test(request.audienceVersion)
    || !exact(request.selection, ["start", "end"]) || !revision(request.selection.start) || !revision(request.selection.end)
    || request.selection.start >= request.selection.end || request.selection.end > 262144))
    fail(422, "invalid_inbox_share", "Select exact email text and the current room audience.");
}
export const inboxAudience = state => Object.values(state.members).filter(m => m.active === true)
  .map(m => ({ memberId: m.id, revision: m.revision })).sort((a, b) => a.memberId.localeCompare(b.memberId));
const viewer = auth => ({ accountId: auth.account.id, authEpoch: auth.account.authEpoch,
  sessionBinding: auth.sessionBinding, sessionRevision: auth.sessionRevision });
const sharedBody = (data, request) => {
  if (request.action === "source.excerpt") {
    if (data.adapter !== "email" || data.envelope.body.format !== "text") fail(409, "email_sharing_unavailable", "Only plain-text email excerpts can be shared.");
    const content = emailSelectionText(readEmailEnvelope(data.envelope).body), { start, end } = request.selection;
    const excerpt = content.slice(start, end), body = "Shared email excerpt\n\n" + excerpt;
    if (end > content.length || !text(excerpt, 4000) || body.length > 4000)
      fail(422, "invalid_inbox_share", "Choose nonempty text up to 4,000 characters including the excerpt label.");
    return body;
  }
  const indexes = request.paragraphs;
  if (data.adapter !== "synthetic") fail(409, "email_sharing_unavailable", "Email excerpt sharing is not yet available.");
  if (indexes.some(i => !Object.hasOwn(data.paragraphs, i))) fail(422, "invalid_inbox_share", "Selected text does not exist.");
  const body = "Shared sample excerpt\n\n" + indexes.map(i => data.paragraphs[i]).join("\n\n");
  if (body.length > 4000) fail(422, "invalid_inbox_share", "Choose at most 4,000 characters including the excerpt label.");
  return body;
};
export class Inbox {
  constructor(store) { this.store = store; this.db = store.db; }
  auth(token, binding, roomId = null) {
    if (typeof binding !== "string" || !/^[a-f0-9]{64}$/.test(binding)) fail(422, "session_binding_required", "Current account session binding required.");
    return this.store.authenticateAccountSession(token, roomId, binding);
  }
  source(accountId, id) {
    if (!validId(id)) fail(422, "invalid_inbox_source", "Choose a source.");
    const row = this.db.prepare("SELECT * FROM private_inbox_sources WHERE account_id=? AND id=?").get(accountId, id);
    if (!row) fail(404, "inbox_source_not_found", "Source not found.");
    return row;
  }
  version(accountId, id, number) {
    const row = this.db.prepare("SELECT data_json FROM private_inbox_versions WHERE account_id=? AND source_id=? AND revision=?").get(accountId, id, number);
    if (!row) fail(404, "inbox_source_not_found", "Source version not found.");
    return JSON.parse(row.data_json);
  }
  list(token, binding, { includeEmail = false } = {}) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding);
      const sources = this.db.prepare("SELECT * FROM private_inbox_sources WHERE account_id=? ORDER BY updated_at DESC,id").all(auth.account.id)
        .map(row => { const d = this.version(auth.account.id, row.id, row.revision);
          if (d.adapter === "email" && !includeEmail) return null;
          return { id: row.id, revision: row.revision, adapter: d.adapter,
            sender: d.adapter === "email" ? d.envelope.message.from.address : d.sender,
            recipient: d.adapter === "email" ? d.envelope.connection.identity.address : d.recipient,
            subject: d.adapter === "email" ? d.envelope.message.subject : d.subject, updatedAt: row.updated_at }; }).filter(Boolean);
      return { contractVersion: 1, viewer: viewer(auth), sources };
    });
  }
  read(token, sourceId, binding, { emailView = false, excerptView = false } = {}) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding), row = this.source(auth.account.id, sourceId);
      const draft = this.db.prepare("SELECT revision,source_revision,body,updated_at FROM private_inbox_drafts WHERE account_id=? AND source_id=?").get(auth.account.id, sourceId);
      const data = this.version(auth.account.id, row.id, row.revision);
      const source = emailView && data.adapter === "email" ? this.emailView(auth, row, data.envelope, excerptView) : { id: row.id, revision: row.revision, ...data };
      return { contractVersion: 1, viewer: viewer(auth), source,
        draft: draft ? { revision: draft.revision, sourceRevision: draft.source_revision, body: draft.body, updatedAt: draft.updated_at,
          origin: this.draftOrigin(auth.account.id, sourceId, draft.body, row.revision) } : null };
    });
  }
  emailView(auth, row, value, excerptView = false) {
    const envelope = readEmailEnvelope(value), { message, body, attachments } = envelope;
    const saved = this.db.prepare("SELECT data_json FROM private_email_connections WHERE account_id=? AND id=?")
      .get(auth.account.id, envelope.connection.id);
    if (!saved || envelope.connection.accountId !== auth.account.id) fail(409, "email_connection_unavailable", "Email connection unavailable.");
    const connection = JSON.parse(saved.data_json);
    const connectionState = connection.state === "disconnected" ? "disconnected"
      : connection.authEpoch !== auth.account.authEpoch ? "reconnect_required" : "active";
    // A bounded, inert reading projection, never a provider/send envelope. Keep
    // cursors, headers, HTML, attachment descriptors and mailbox IDs off this path.
    return { id: row.id, revision: row.revision, adapter: "email", sender: message.from.address,
      recipient: envelope.connection.identity.address, subject: message.subject,
      paragraphs: body.format === "text" ? [excerptView ? emailSelectionText(body) : body.content] : [],
      capabilities: { draft: true, share: excerptView && body.format === "text" && Boolean(body.content.trim()), send: false },
      email: { view: excerptView ? "email-excerpt-v1" : "email-text-v1", accountId: auth.account.id, format: body.format, connectionState,
        to: message.to.map(a => a.address), cc: message.cc.map(a => a.address), bcc: message.bcc.map(a => a.address),
        attachmentState: attachments.state, attachmentCount: attachments.items.length } };
  }
  draftOrigin(accountId, sourceId, body, sourceRevision) {
    const row = this.db.prepare(`SELECT request_json,receipt_json FROM private_inbox_commands WHERE account_id=?
      AND json_extract(request_json,'$.sourceId')=? AND (json_extract(request_json,'$.action')='draft.adopt'
      OR (json_extract(request_json,'$.action')='draft.save' AND json_extract(request_json,'$.body')='')) ORDER BY sequence DESC LIMIT 1`).get(accountId, sourceId);
    if (!row || JSON.parse(row.request_json).action !== "draft.adopt") return null;
    const adopted = JSON.parse(row.receipt_json);
    return { ...adopted.origin, unchanged: body === adopted.body, sourceChanged: sourceRevision !== adopted.sourceRevision };
  }
  shares(accountId, sourceId, roomId, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare(`SELECT sequence,request_id,request_json,receipt_json FROM private_inbox_commands WHERE account_id=? AND sequence<?
      AND json_extract(request_json,'$.sourceId')=? AND json_extract(request_json,'$.roomId')=?
      AND json_extract(request_json,'$.action') IN ('source.share','source.excerpt') ORDER BY sequence DESC`).all(accountId, before, sourceId, roomId)
      .map(row => ({ ...row, request: JSON.parse(row.request_json), receipt: JSON.parse(row.receipt_json) }));
  }
  resultRecord(sourceRevision, share, item, state) {
    const base = { workItemId: item.id, title: item.title, shareRequestId: share.request_id,
      sourceRevision: share.request.sourceRevision, messageId: share.receipt.messageId };
    const status = share.request.sourceRevision !== sourceRevision ? "source_changed"
      : item.supersededBy || item.state === "superseded" ? "superseded"
      : !item.receipt?.nativeText ? "no_native_result"
      : !hasConfirmedIndependentPass(item) || !currentApproval(item) || state.members[item.decision?.actorId]?.kind !== "human" ? "needs_review" : "ready";
    if (status !== "ready") return { ...base, status, resultVersion: null };
    const evidence = storedText(this.db, state, item.id, item.receipt.nativeText.messageId, item.receipt.nativeText.messageEventId);
    if (evidence.body.length > 4000) return { ...base, status: "too_long", resultVersion: null };
    const proof = { roomId: state.room.id, workItemId: item.id, shareRequestId: share.request_id,
      sourceRevision, messageId: share.receipt.messageId, workRevision: item.revision,
      completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion,
      verificationEventId: item.verification.eventId, decisionEventId: item.decision.eventId };
    return { ...base, status, resultVersion: digest(proof), proof, body: evidence.body };
  }
  results(token, sourceId, roomId, binding, workItemId = null) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding, roomId), source = this.source(auth.account.id, sourceId), { state } = this.store.room(roomId);
      if (workItemId !== null && !validId(workItemId)) fail(422, "invalid_inbox_result", "Choose a result.");
      const shares = new Map(this.shares(auth.account.id, sourceId, roomId).map(s => [s.receipt.messageId, s]));
      const items = Object.values(state.workItems).filter(i => shares.has(i.sourceMessageId) && (workItemId === null || i.id === workItemId));
      if (workItemId !== null && !items.length) fail(404, "inbox_result_not_found", "Result not found.");
      return { contractVersion: 1, viewer: viewer(auth), sourceId, roomId, sourceRevision: source.revision,
        results: items.map(item => {
          const value = this.resultRecord(source.revision, shares.get(item.sourceMessageId), item, state);
          if (workItemId === null) { delete value.body; delete value.proof; }
          return value;
        }) };
    });
  }
  adopted(accountId, request, room, before) {
    const share = this.shares(accountId, request.sourceId, request.roomId, before).find(s => s.request_id === request.shareRequestId);
    const item = room.state.workItems[request.workItemId];
    if (!share || !item || item.sourceMessageId !== share.receipt.messageId) fail(404, "inbox_result_not_found", "Result not found.");
    const result = this.resultRecord(request.sourceRevision, share, item, room.state);
    if (result.status !== "ready" || result.resultVersion !== request.resultVersion)
      fail(409, "stale_inbox_result", "Result or review changed. Review again.");
    return { body: result.body, origin: { ...result.proof, roomSequence: room.sequence } };
  }
  shareContext(token, sourceId, roomId, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding, roomId), row = this.source(auth.account.id, sourceId), state = this.store.room(roomId).state;
      return { contractVersion: 1, viewer: viewer(auth), sourceId, sourceRevision: row.revision, roomId, roomTitle: state.room.title,
        audienceVersion: digest(inboxAudience(state)), audience: inboxAudience(state),
        members: Object.values(state.members).filter(m => m.active === true).map(m => ({ id: m.id, displayName: m.displayName, kind: m.kind })) };
    });
  }
  outbox(accountId, sourceId = null) {
    const sends = new Map();
    for (const row of this.db.prepare("SELECT receipt_json FROM private_inbox_commands WHERE account_id=? AND json_extract(receipt_json,'$.action') LIKE 'send.%' ORDER BY sequence").all(accountId)) {
      const receipt = JSON.parse(row.receipt_json);
      if (isSend(receipt) && (sourceId === null || receipt.sourceId === sourceId)) sends.set(receipt.send.id, receipt.send);
    }
    return sends;
  }
  preview(accountId, authEpoch, sourceId) {
    const source = this.source(accountId, sourceId), data = this.version(accountId, sourceId, source.revision);
    const draft = this.db.prepare("SELECT * FROM private_inbox_drafts WHERE account_id=? AND source_id=?").get(accountId, sourceId);
    return sendPreview(accountId, authEpoch, source, data, draft);
  }
  sendContext(token, sourceId, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding);
      return { contractVersion: 1, viewer: viewer(auth), sourceId,
        preview: this.preview(auth.account.id, auth.account.authEpoch, sourceId) };
    });
  }
  sends(token, sourceId, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding); this.source(auth.account.id, sourceId);
      return { contractVersion: 1, viewer: viewer(auth), sourceId, sends: [...this.outbox(auth.account.id, sourceId).values()] };
    });
  }
  // For a trusted adapter driver only. HTTP commands cannot manufacture provider
  // outcomes or mark an attempt dispatchable. This method performs no I/O.
  transport(token, request, binding) {
    if (!internalSend(request)) fail(422, "invalid_inbox_send", "Supply a transport transition.");
    return this.apply(token, request, binding, transportAuthority);
  }
  replyHistory(accountId, sourceId = null) {
    return this.replyRecords(accountId, sourceId, "attempt");
  }
  replyUpdateHistory(accountId, sourceId = null) {
    return this.replyRecords(accountId, sourceId, "update");
  }
  replyRecords(accountId, sourceId, field) {
    const attempts = new Map();
    for (const row of this.db.prepare("SELECT receipt_json FROM private_inbox_commands WHERE account_id=? AND json_extract(receipt_json,'$.action') LIKE 'reply.%' ORDER BY sequence").all(accountId)) {
      const receipt = JSON.parse(row.receipt_json);
      if (receipt[field] && (sourceId === null || receipt.sourceId === sourceId)) attempts.set(receipt[field].id, receipt[field]);
    }
    return attempts;
  }
  replyUpdates(token, sourceId, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding); this.source(auth.account.id, sourceId);
      return { contractVersion: 1, viewer: viewer(auth), sourceId, updates: [...this.replyUpdateHistory(auth.account.id, sourceId).values()] };
    });
  }
  replyAttempts(token, sourceId, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding); this.source(auth.account.id, sourceId);
      const attempts = [...this.replyHistory(auth.account.id, sourceId).values()].map(attempt => {
        if (!attempt.review) return attempt;
        const reviewCurrent = this.replyPlanCurrent(token, attempt, binding) && attempt.review.authEpoch === auth.account.authEpoch;
        return { ...attempt, reviewCurrent };
      });
      return { contractVersion: 1, viewer: viewer(auth), sourceId, attempts };
    });
  }
  replyPlanCurrent(token, attempt, binding) {
    try {
      if (unresolvedReplyUpdate(this.replyUpdateHistory(attempt.plan.accountId, attempt.sourceId), attempt.id)) return false;
      const plan = prepareGraphReplyDraft({ store: this.store, token, binding, sourceId: attempt.sourceId,
        requestId: attempt.plan.requestId, mode: attempt.plan.mode });
      return plan.planVersion === attempt.plan.planVersion;
    } catch (error) {
      if (!(error instanceof ServiceError) && !(error instanceof EmailContractError)) throw error;
      return false;
    }
  }
  // Negotiated, account-private projection; no transport plan or provider IDs.
  replyReviewContext(token, sourceId, binding, { view = "reply-review-v1" } = {}) {
    if (!["reply-review-v1", "reply-review-v2", "reply-review-v3"].includes(view)) fail(422, "unsupported_inbox_view", "Choose the supported reply review.");
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding); this.source(auth.account.id, sourceId);
      const prior = [...this.replyHistory(auth.account.id, sourceId).values()].find(value => value.status !== "cancelled");
      let attempt = null;
      if (prior) {
        const current = this.replyPlanCurrent(token, prior, binding);
        const o = prior.observation, d = o?.draft;
        attempt = { id: prior.id, revision: prior.revision, status: prior.status, sourceRevision: prior.plan.sourceRevision,
          draftRevision: prior.plan.draftRevision, canSend: false, canReview: current && replyObservationReviewable(o),
          observation: d ? { version: o.reviewVersion, from: d.from.address, sender: d.sender.address,
            to: d.to.map(a => a.address), cc: d.cc.map(a => a.address), bcc: d.bcc.map(a => a.address),
            subject: d.subject, body: d.body, format: d.format, attachmentState: d.attachmentState,
            attachmentCount: d.attachmentCount, differences: o.differences } : null,
          review: prior.review ? { version: prior.review.version, at: prior.review.at,
            current: current && prior.review.authEpoch === auth.account.authEpoch } : null };
      }
      const value = { contractVersion: 1, view, viewer: viewer(auth), sourceId, attempt };
      if (view !== "reply-review-v1") {
        const update = prior && [...this.replyUpdateHistory(auth.account.id, sourceId).values()].find(u => u.attemptId === prior.id && u.status !== "cancelled");
        // v2 knows only unresolved completion; v3 can distinguish the write
        // acknowledgment from the still-pending content review.
        const status = update?.status ?? null;
        value.comparison = prior ? { originalBody: prior.plan.expected.body,
          updateStatus: view === "reply-review-v2" && status === "update_acknowledged" ? "update_unconfirmed" : status } : null;
      }
      return value;
    });
  }
  // Narrow human acknowledgment boundary. Never expose provider/dispatch writes.
  reviewReply(token, request, binding) {
    if (request?.action !== "reply.review") fail(422, "invalid_reply_review", "Choose the exact observed draft.");
    const result = this.reply(token, request, binding), { attempt, ...receipt } = result.receipt;
    return { ...result, receipt: { ...receipt, attemptId: attempt.id, revision: attempt.revision, reviewVersion: attempt.review.version } };
  }
  // Fixture-only service boundary; not mounted as a browser or agent command.
  reply(token, request, binding) {
    if (!isReplyAttempt(request)) fail(422, "invalid_reply_attempt", "Supply a reply transition.");
    return this.apply(token, request, binding, replyAuthority);
  }
  recordReplyCreation(token, { sourceId, attemptId, expectedRevision, requestId, response }, binding) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding), attempt = this.replyHistory(auth.account.id, sourceId).get(attemptId);
      if (!attempt) fail(404, "reply_attempt_not_found", "Reply attempt not found.");
      // Reconciliation uses the retained intent, not today's edited draft or connection.
      const observed = classifyGraphReplyCreation(attempt.plan, response);
      if (observed.status === "creation_unconfirmed") return { attempt, recorded: false, canRetryCreate: false };
      const result = this.reply(token, { action: "reply.created", requestId, sourceId, attemptId, expectedRevision,
        planVersion: attempt.plan.planVersion, providerDraftId: observed.providerDraftId }, binding);
      return { ...result, recorded: true };
    });
  }
  recordReplyObservation(token, { sourceId, attemptId, expectedRevision, requestId, response }, binding) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding), attempt = this.replyHistory(auth.account.id, sourceId).get(attemptId);
      if (!attempt?.providerDraftId) fail(409, "reply_draft_unconfirmed", "A confirmed mailbox draft identity is required.");
      return this.reply(token, { action: "reply.observed", requestId, sourceId, attemptId, expectedRevision,
        observation: normalizeReplyObservation(attempt.plan, response) }, binding);
    });
  }
  recordReplyUpdateObservation(token, { sourceId, attemptId, updateId, expectedRevision, requestId, response }, binding) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding), update = this.replyUpdateHistory(auth.account.id, sourceId).get(updateId);
      if (!update || update.attemptId !== attemptId) fail(404, "reply_update_not_found", "Reply update not found.");
      return this.reply(token, { action: "reply.update.observed", requestId, sourceId, attemptId, updateId, expectedRevision,
        observation: normalizeReplyObservation(update.proposal, response) }, binding);
    });
  }
  recordReplyUpdateAcknowledgment(token, { sourceId, attemptId, updateId, dispatchRequestId, requestId, response }, binding) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding), update = this.replyUpdateHistory(auth.account.id, sourceId).get(updateId);
      if (!update || update.attemptId !== attemptId) fail(404, "reply_update_not_found", "Reply update not found.");
      const acknowledgment = classifyGraphReplyUpdateAcknowledgment(update.proposal, response);
      if (!acknowledgment) return { update, recorded: false, canRetryUpdate: false };
      return { ...this.reply(token, { action: "reply.update.acknowledged", requestId, sourceId, attemptId, updateId,
        dispatchRequestId, ...acknowledgment }, binding), recorded: true };
    });
  }
  // Trusted, transaction-bound importer only. Ordinary HTTP commands cannot use it.
  importSource(token, request, binding) {
    if (!this.db.isTransaction || request?.action !== "source.import") fail(403, "email_importer_required", "Use the transactional email importer.");
    return this.apply(token, request, binding, importAuthority);
  }
  apply(token, request, binding, authority = null) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding); validate(request);
      if (isReplyAttempt(request) && authority !== replyAuthority) fail(403, "reply_driver_required", "Use the configured reply driver.");
      if (internalSend(request) && authority !== transportAuthority) fail(403, "inbox_transport_required", "Only the configured transport can record this outcome.");
      if (request.action === "source.import" && authority !== importAuthority) fail(403, "email_importer_required", "Only the configured importer can record this source.");
      if (request.action === "source.import" && request.data.envelope.connection.accountId !== auth.account.id)
        fail(403, "email_account_mismatch", "Email observation belongs to another account.");
      if (isShare(request) || request.action === "draft.adopt") this.auth(token, binding, request.roomId);
      const accountId = auth.account.id, fingerprint = digest(request);
      const prior = this.db.prepare("SELECT fingerprint,receipt_json FROM private_inbox_commands WHERE account_id=? AND request_id=?").get(accountId, request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Request ID already used for different inbox content.");
        return { contractVersion: 1, viewer: viewer(auth), receipt: JSON.parse(prior.receipt_json), duplicate: true };
      }
      if (!internalSend(request) && request.action !== "send.cancel" && !["reply.cancel", "reply.created", "reply.update.cancel", "reply.update.acknowledged"].includes(request.action)
        && this.db.prepare("SELECT count(*) n FROM private_inbox_commands WHERE account_id=?").get(accountId).n >= inboxLimits.commands)
        fail(409, "inbox_limit", "Private inbox pilot capacity reached.");
      const now = this.store.now(), { sourceId, action, requestId } = request;
      let receipt = { requestId, action, sourceId };
      if (isReplyUpdate(request)) {
        this.source(accountId, sourceId);
        const updates = this.replyUpdateHistory(accountId), prior = updates.get(request.updateId);
        const proposal = ["reply.update.reserve", "reply.update.dispatch"].includes(action) ? prepareGraphReplyUpdate({ store: this.store, token, binding,
          sourceId, attemptId: request.attemptId, requestId: action === "reply.update.reserve" ? requestId : prior?.proposal.requestId,
          expectedRevision: action === "reply.update.reserve" ? request.expectedRevision : prior?.proposal.attemptRevision }) : null;
        const dispatch = action === "reply.update.acknowledged"
          ? this.db.prepare("SELECT receipt_json FROM private_inbox_commands WHERE account_id=? AND request_id=?").get(accountId, request.dispatchRequestId) : null;
        receipt.update = transitionReplyUpdate(updates, request, { proposal, dispatch: dispatch && JSON.parse(dispatch.receipt_json), at: now });
      } else if (isReplyAttempt(request)) {
        this.source(accountId, sourceId);
        const attempts = this.replyHistory(accountId), original = attempts.get(request.attemptId);
        if (action === "reply.review" && unresolvedReplyUpdate(this.replyUpdateHistory(accountId), request.attemptId))
          fail(409, "reply_update_unresolved", "Check the existing update before reviewing.");
        const plan = ["reply.reserve", "reply.dispatch", "reply.review"].includes(action) ? prepareGraphReplyDraft({ store: this.store, token, binding,
          sourceId, requestId: action === "reply.reserve" ? requestId : original?.plan.requestId,
          mode: action === "reply.reserve" ? request.mode : original?.plan.mode }) : null;
        receipt.attempt = transitionReplyAttempt(attempts, request, { plan, authEpoch: auth.account.authEpoch, at: now });
      } else if (isSend(request)) {
        this.source(accountId, sourceId);
        receipt.send = transitionSend(this.outbox(accountId), request, {
          preview: ["send.reserve", "send.dispatch"].includes(action) ? this.preview(accountId, auth.account.authEpoch, sourceId) : null,
          authEpoch: auth.account.authEpoch, at: now });
      } else if (["source.save", "source.import"].includes(action)) {
        const previous = this.db.prepare("SELECT * FROM private_inbox_sources WHERE account_id=? AND id=?").get(accountId, sourceId);
        if (previous && this.version(accountId, sourceId, previous.revision).adapter !== request.data.adapter)
          fail(409, "inbox_source_origin_changed", "A source cannot change its channel origin.");
        if ((previous?.revision ?? 0) !== request.expectedRevision) fail(409, "stale_inbox_source", "Source changed. Review the current version.");
        if ((previous?.revision ?? 0) >= inboxLimits.versions || !previous && this.db.prepare("SELECT count(*) n FROM private_inbox_sources WHERE account_id=?").get(accountId).n >= inboxLimits.sources)
          fail(409, "inbox_limit", "Private inbox pilot capacity reached.");
        receipt.revision = request.expectedRevision + 1;
        this.db.prepare(`INSERT INTO private_inbox_sources VALUES(?,?,?,?,?) ON CONFLICT(account_id,id)
          DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`).run(accountId, sourceId, receipt.revision, now, now);
        this.db.prepare("INSERT INTO private_inbox_versions VALUES(?,?,?,?)").run(accountId, sourceId, receipt.revision, JSON.stringify(request.data));
      } else {
        const source = this.source(accountId, sourceId);
        if (source.revision !== request.sourceRevision) fail(409, "stale_inbox_source", "Source changed. Review the current version.");
        if (action === "draft.save" || action === "draft.adopt") {
          const old = this.db.prepare("SELECT revision FROM private_inbox_drafts WHERE account_id=? AND source_id=?").get(accountId, sourceId);
          if ((old?.revision ?? 0) !== request.expectedRevision) fail(409, "stale_inbox_draft", "Draft changed. Keep both versions and review.");
          Object.assign(receipt, { revision: request.expectedRevision + 1, sourceRevision: request.sourceRevision });
          if (action === "draft.adopt") Object.assign(receipt, this.adopted(accountId, request, this.store.room(request.roomId)));
          this.db.prepare(`INSERT INTO private_inbox_drafts VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,source_id)
            DO UPDATE SET revision=excluded.revision,source_revision=excluded.source_revision,body=excluded.body,updated_at=excluded.updated_at`)
            .run(accountId, sourceId, receipt.revision, receipt.sourceRevision, action === "draft.adopt" ? receipt.body : request.body, now);
        } else {
          const room = this.store.room(request.roomId);
          if (request.audienceVersion !== digest(inboxAudience(room.state))) fail(409, "stale_inbox_audience", "Room audience changed. Review who will see this excerpt.");
          const messageId = "excerpt-" + digest([accountId, requestId]);
          const result = this.store.command(token, request.roomId, { id: "inbox-" + digest([accountId, requestId]), type: T.MESSAGE_POSTED,
            data: { messageId, body: sharedBody(this.version(accountId, sourceId, source.revision), request) } }, binding);
          Object.assign(receipt, { sourceRevision: source.revision, roomId: request.roomId, messageId, eventId: result.event.id, sequence: result.sequence });
        }
      }
      this.db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
        .run(accountId, requestId, fingerprint, JSON.stringify(request), JSON.stringify(receipt), auth.account.authEpoch, now);
      return { contractVersion: 1, viewer: viewer(auth), receipt, duplicate: false };
    });
  }
  verify() {
    return this.store.readTransaction(() => {
    const require = condition => { if (!condition) throw new Error("Private inbox requires operator reconciliation"); };
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/\s+/g, " ");
    for (const sql of inboxSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)) {
      const name = /^CREATE (?:TABLE|TRIGGER) ([a-z_]+)/.exec(sql.trim())[1];
      require(normalize(this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql) === normalize(sql));
    }
    const sources = new Map(), drafts = new Map(), historicalRooms = new Map(), outboxes = new Map(), replyBoxes = new Map(), updateBoxes = new Map(), dispatches = new Map(); let versions = 0;
    for (const row of this.db.prepare("SELECT * FROM private_inbox_commands ORDER BY sequence").all()) {
      const request = JSON.parse(row.request_json), receipt = JSON.parse(row.receipt_json); validate(request);
      require(row.request_id === request.requestId && row.fingerprint === digest(request) && revision(row.auth_epoch) && Number.isSafeInteger(row.at));
      const key = canonical([row.account_id, request.sourceId]), prior = sources.get(key);
      const expected = { requestId: request.requestId, action: request.action, sourceId: request.sourceId };
      if (isReplyAttempt(request)) {
        require(prior);
        if (!replyBoxes.has(row.account_id)) replyBoxes.set(row.account_id, new Map());
        if (!updateBoxes.has(row.account_id)) updateBoxes.set(row.account_id, new Map());
        const attempts = replyBoxes.get(row.account_id), original = attempts.get(request.attemptId);
        const updates = updateBoxes.get(row.account_id), child = updates.get(request.updateId);
        let plan = null, proposal = null;
        if (["reply.reserve", "reply.dispatch", "reply.review", "reply.update.reserve", "reply.update.dispatch"].includes(request.action)) {
          const data = this.version(row.account_id, request.sourceId, prior.revision), draft = drafts.get(key);
          const profile = data.envelope?.connection;
          const configured = this.db.prepare("SELECT request_json,auth_epoch FROM private_email_commands WHERE account_id=? AND json_extract(request_json,'$.action')='connection.configure' AND json_extract(receipt_json,'$.connectionId')=? AND json_extract(receipt_json,'$.revision')=?")
            .get(row.account_id, profile?.id ?? "", profile?.revision ?? -1);
          require(configured && configured.auth_epoch === row.auth_epoch && same(JSON.parse(configured.request_json).profile, profile));
          const context = { auth: { account: { id: row.account_id, authEpoch: row.auth_epoch } },
            source: { id: request.sourceId, revision: prior.revision, ...data },
            draft: draft ? { revision: draft.revision, sourceRevision: draft.source_revision, body: draft.body } : null,
            connection: { profile, mode: "fixture", state: "active", authEpoch: row.auth_epoch } };
          if (isReplyUpdate(request)) proposal = buildGraphReplyUpdate({ ...context, attempt: original,
            requestId: request.action === "reply.update.reserve" ? request.requestId : child?.proposal.requestId,
            expectedRevision: request.action === "reply.update.reserve" ? request.expectedRevision : child?.proposal.attemptRevision });
          else plan = buildGraphReplyDraft({ ...context,
            requestId: request.action === "reply.reserve" ? request.requestId : original?.plan.requestId,
            mode: request.action === "reply.reserve" ? request.mode : original?.plan.mode });
        }
        if (isReplyUpdate(request)) {
          expected.update = transitionReplyUpdate(updates, request, { proposal,
            dispatch: dispatches.get(canonical([row.account_id, request.dispatchRequestId])), at: row.at });
          updates.set(expected.update.id, expected.update);
          if (request.action === "reply.update.dispatch") dispatches.set(canonical([row.account_id, request.requestId]), expected);
        } else {
          require(request.action !== "reply.review" || !unresolvedReplyUpdate(updates, request.attemptId));
          expected.attempt = transitionReplyAttempt(attempts, request, { plan, authEpoch: row.auth_epoch, at: row.at });
          attempts.set(expected.attempt.id, expected.attempt);
        }
      } else if (isSend(request)) {
        require(prior);
        if (!outboxes.has(row.account_id)) outboxes.set(row.account_id, new Map());
        const sends = outboxes.get(row.account_id);
        const preview = ["send.reserve", "send.dispatch"].includes(request.action)
          ? sendPreview(row.account_id, row.auth_epoch, prior, this.version(row.account_id, request.sourceId, prior.revision), drafts.get(key)) : null;
        expected.send = transitionSend(sends, request, { preview, authEpoch: row.auth_epoch, at: row.at });
        sends.set(expected.send.id, expected.send);
      } else if (["source.save", "source.import"].includes(request.action)) {
        require(request.expectedRevision === (prior?.revision ?? 0));
        if (request.action === "source.import") require(request.data.envelope.connection.accountId === row.account_id);
        if (prior) require(this.version(row.account_id, request.sourceId, prior.revision).adapter === request.data.adapter);
        expected.revision = request.expectedRevision + 1;
        require(same(this.version(row.account_id, request.sourceId, expected.revision), request.data));
        sources.set(key, { account_id: row.account_id, id: request.sourceId, revision: expected.revision, created_at: prior?.created_at ?? row.at, updated_at: row.at }); versions++;
      } else {
        require(prior?.revision === request.sourceRevision);
        if (request.action === "draft.save" || request.action === "draft.adopt") {
          require(request.expectedRevision === (drafts.get(key)?.revision ?? 0));
          Object.assign(expected, { revision: request.expectedRevision + 1, sourceRevision: request.sourceRevision });
          if (request.action === "draft.adopt") {
            require(revision(receipt.origin?.roomSequence) && receipt.origin.roomSequence > 0);
            const roomKey = canonical([request.roomId, receipt.origin.roomSequence]);
            if (!historicalRooms.has(roomKey)) historicalRooms.set(roomKey, this.store.rebuildProjection(request.roomId, receipt.origin.roomSequence));
            Object.assign(expected, this.adopted(row.account_id, request, historicalRooms.get(roomKey), row.sequence));
          }
          drafts.set(key, { account_id: row.account_id, source_id: request.sourceId, revision: expected.revision, source_revision: request.sourceRevision,
            body: request.action === "draft.adopt" ? expected.body : request.body, updated_at: row.at });
        } else {
          const eventRow = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND id=?").get(request.roomId, receipt.eventId);
          require(eventRow); const event = JSON.parse(eventRow.body);
          const member = this.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(request.roomId, row.account_id);
          const messageId = "excerpt-" + digest([row.account_id, request.requestId]);
          require(event.actorId === member?.member_id && event.type === T.MESSAGE_POSTED
            && same(event.data, { messageId, body: sharedBody(this.version(row.account_id, request.sourceId, request.sourceRevision), request) }));
          Object.assign(expected, { sourceRevision: request.sourceRevision, roomId: request.roomId, messageId, eventId: receipt.eventId, sequence: eventRow.sequence });
        }
      }
      require(same(receipt, expected));
    }
    const rows = name => this.db.prepare("SELECT * FROM " + name).all().map(canonical).sort();
    require(same(rows("private_inbox_sources"), [...sources.values()].map(canonical).sort()));
    require(same(rows("private_inbox_drafts"), [...drafts.values()].map(canonical).sort()));
    require(this.db.prepare("SELECT count(*) n FROM private_inbox_versions").get().n === versions);
    return { sources: sources.size, drafts: drafts.size, versions };
    });
  }
}
