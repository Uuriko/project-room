import { gmailImportAuth } from './gmail-import-authority.mjs';
import { createHash } from "node:crypto";
import { validId, EVENT_TYPES as T, hasConfirmedIndependentPass } from "../src/events.js";
import { currentApproval } from "../src/workflow.js";
import { storedText } from "./text-results.mjs";
import { ServiceError } from "./store.mjs";
import { isSend, internalSend, validateSend, sendPreview, transitionSend } from "./inbox-outbox.mjs";
import { readEmailEnvelope, EmailContractError } from "./email-envelope.mjs";
import { indexMessages, search as runInboxSearch } from "./inbox-search.mjs";
import { buildThreads } from "./inbox-threads.mjs";
import { readChannelEnvelope } from "./channel-adapters/index.mjs";
import { assessThreadSla, slaTargets } from "./sla-clocks.mjs";
import { buildSlaDashboard } from "./sla-dashboard.mjs";
import { InboxStitchStore } from "./inbox-stitch-store.mjs";
import { createNotifyPrefs } from "./notify-prefs.mjs";
import { runImportGuards, replayImportedNotification, scoreImportedEnvelope } from "./inbox-import-guards.mjs";
import { shadowDecisionForImport } from "./spam-shadow.mjs";
import { spamQuarantineStatuses } from "./spam-quarantine-journal.mjs";
import { reviewCoverageBySignal } from "./quarantine-review-coverage.mjs";
import { channels, connectionState, profileChannel } from "./channel-connection.mjs";
import { prepareGraphReplyDraft, buildGraphReplyDraft, classifyGraphReplyCreation, classifyGraphReplyUpdateAcknowledgment, normalizeReplyObservation, prepareGraphReplyUpdate, buildGraphReplyUpdate, compareReplyUpdateEnvelope } from "./graph-reply-draft.mjs";
import { isReplyAttempt, validateReplyAttempt, transitionReplyAttempt, replyObservationReviewable, isReplyUpdate, transitionReplyUpdate } from "./graph-reply-journal.mjs";
import { buildUpdateInspection, buildUpdateReview, replyAttemptWithObservation } from "./graph-reply-update-review.mjs";

const transportAuthority = Symbol("private inbox transport");
const importAuthority = Symbol("private email importer");
const replyAuthority = Symbol("private fixture reply driver");

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// Stitch store errors carry stable machine codes; translate the expected
// owner/API failures to HTTP statuses here so they never surface as 500s.
// Auth/session behavior is untouched: this only runs after this.auth().
const stitchResult = fn => {
  try { return fn(); }
  catch (error) {
    if (error?.code === "stitch_not_enabled") fail(409, error.code, "Cross-channel stitching is not enabled for this room.");
    if (error?.code === "stitch_suggestion_not_found") fail(404, error.code, "That stitch suggestion was not found.");
    if (error?.code === "stitch_suggestion_resolved") fail(409, error.code, "That stitch suggestion is already resolved.");
    if (error?.code === "stitch_invalid_input") fail(422, error.code, "That stitch request is not valid.");
    throw error;
  }
};
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : value && typeof value === "object"
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const exact = (v, fields) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(f => Object.hasOwn(v, f));
const revision = n => Number.isSafeInteger(n) && n >= 0;
const isShare = request => ["source.share", "source.excerpt"].includes(request.action);
const emailSelectionText = body => body.content.replace(/\r\n?/g, "\n");
const text = (v, max, empty = false) => typeof v === "string" && v.isWellFormed() && v.length <= max && (empty || v.trim().length > 0);
const same = (a, b) => canonical(a) === canonical(b);
const participantLabel = p => p.displayName || p.handle || p.id;
// Cursor pagination for the source list. The cursor is an opaque base64url
// encoding of the (updated_at, id) sort key of the last row on the previous
// page; both fields are already exposed per source, so it leaks nothing new.
// The page window is computed over rows, not returned sources: rows filtered
// by the channel-visibility rule still advance the cursor, so pages never
// skip or duplicate.
const pageLimitOf = value => {
  if (value === undefined || value === null) return 25;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 100) fail(422, "invalid_limit", "limit must be an integer 1..100");
  return n;
};
const decodeCursor = value => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(422, "invalid_cursor", "The page cursor is not valid.");
  let key;
  try { key = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { fail(422, "invalid_cursor", "The page cursor is not valid."); }
  if (!key || typeof key !== "object" || !Number.isInteger(key.updatedAt) || typeof key.id !== "string" || !key.id)
    fail(422, "invalid_cursor", "The page cursor is not valid.");
  return key;
};
const encodeCursor = key => Buffer.from(JSON.stringify({ updatedAt: key.updatedAt, id: key.id }), "utf8").toString("base64url");
// Full-text search bounds. The index is built per request over the same
// reading projection the UI shows (subject + paragraphs) — never cursors,
// headers, HTML, mailbox IDs, or secrets. At most 5000 sources enter the
// index; at most 200 results leave it.
const searchLimitOf = value => {
  if (value === undefined || value === null) return 25;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 200) fail(422, "invalid_limit", "limit must be an integer 1..200");
  return n;
};
const threadLimitOf = value => {
  if (value === undefined || value === null) return 25;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 50) fail(422, "invalid_limit", "limit must be an integer 1..50");
  return n;
};
const searchText = d => {
  try {
    if (d.adapter === "synthetic") return [d.subject ?? "", ...(d.paragraphs ?? [])].join("\n");
    if (d.adapter === "email") { const e = readEmailEnvelope(d.envelope); return [e.message.subject, e.body.format === "text" ? e.body.content : ""].join("\n"); }
    return readChannelEnvelope(d.envelope).body.content ?? "";
  } catch { return ""; }
};
// One reading summary per source origin: synthetic samples, email, Telegram.
const summary = d => d.adapter === "email" ? { sender: d.envelope.message.from.address, recipient: d.envelope.connection.identity.address, subject: d.envelope.message.subject }
  : d.adapter === "telegram" ? { sender: participantLabel(d.envelope.message.from), recipient: participantLabel(d.envelope.connection.identity), subject: participantLabel(d.envelope.message.to[0]) }
  : { sender: d.sender, recipient: d.recipient, subject: d.subject };
// Needs-you: the message addresses the account owner directly, in the same
// spirit as needsAttention in src/work-selectors.js (a pure view over stored
// facts, never a stored flag). Email: the mailbox or one of its aliases is in
// To (CC alone does not count). Telegram: a private chat with the bot, a
// mention of the bot's handle, or a reply to a message the bot itself sent (a
// providerId the send journal recorded as accepted or delivered).
const addressKey = a => (a?.address ?? "").toLowerCase();
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function inboxNeedsYou(d, sentIds = new Set()) {
  if (d.adapter === "email") {
    const own = new Set([d.envelope.connection.identity, ...(d.envelope.connection.aliases ?? [])].map(addressKey));
    return d.envelope.message.to.some(a => own.has(addressKey(a)));
  }
  if (d.adapter === "telegram") {
    const { message, body, connection } = d.envelope, handle = connection.identity.handle;
    if (message.to[0].kind === "chat") return true;
    if (handle.length > 1 && new RegExp(escapeRegExp(handle) + "(?![A-Za-z0-9_])", "i").test(body.content)) return true;
    return message.replyTo !== null && sentIds.has("telegram:" + message.replyTo);
  }
  return false;
}
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
// Per-source read markers (readAt timestamp; no row means unread). Purely
// additive: reads ride the existing inbox command journal, so the sources
// and versions tables — and their revision lineage — stay untouched.
export const inboxReadSchema = `
  CREATE TABLE IF NOT EXISTS private_inbox_reads (
    account_id TEXT NOT NULL, source_id TEXT NOT NULL, read_at INTEGER NOT NULL CHECK(read_at>0),
    PRIMARY KEY(account_id,source_id),
    FOREIGN KEY(account_id,source_id) REFERENCES private_inbox_sources(account_id,id)
  );
`;
function validate(request) {
  if (isReplyAttempt(request)) return validateReplyAttempt(request);
  if (isSend(request)) return validateSend(request);
  const common = ["requestId", "action", "sourceId"], fields = {
    "source.save": [...common, "expectedRevision", "data"],
    "source.import": [...common, "expectedRevision", "data"],
    "source.read": [...common, "expectedRevision"],
    "source.unread": [...common, "expectedRevision"],
    "draft.save": [...common, "expectedRevision", "sourceRevision", "body"],
    "draft.adopt": [...common, "expectedRevision", "sourceRevision", "roomId", "workItemId", "shareRequestId", "resultVersion"],
    "source.share": [...common, "sourceRevision", "roomId", "audienceVersion", "paragraphs"],
    "source.excerpt": [...common, "sourceRevision", "roomId", "audienceVersion", "selection"]
  }[request?.action];
  if (!fields || !exact(request, fields) || !validId(request.requestId) || !validId(request.sourceId))
    fail(422, "invalid_inbox_request", "Supply an exact inbox operation and stable request ID.");
  if (!isShare(request) && !revision(request.expectedRevision)) fail(422, "invalid_inbox_request", "Current revision required.");
  if (!["source.save", "source.import", "source.read", "source.unread"].includes(request.action) && (!revision(request.sourceRevision) || !request.sourceRevision)) fail(422, "invalid_inbox_request", "Source revision required.");
  if (request.action === "source.import") {
    if (!exact(request.data, ["adapter", "envelope"]) || !channels.includes(request.data.adapter)) fail(422, "invalid_inbox_source", "Supply a qualified channel observation.");
    let envelope;
    try { envelope = readChannelEnvelope(request.data.envelope); }
    catch (error) { if (error instanceof EmailContractError) fail(422, "invalid_inbox_source", "Channel observation could not be confirmed."); throw error; }
    if (envelope.channel !== request.data.adapter || envelope.sourceId !== request.sourceId) fail(422, "invalid_inbox_source", "Source identity does not match the channel observation.");
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
    if (!channels.includes(data.adapter) || data.envelope.body.format !== "text") fail(409, "channel_sharing_unavailable", "Only plain-text excerpts can be shared.");
    const content = emailSelectionText(readChannelEnvelope(data.envelope).body), { start, end } = request.selection;
    const excerpt = content.slice(start, end), body = (data.adapter === "email" ? "Shared email excerpt" : "Shared message excerpt") + "\n\n" + excerpt;
    if (end > content.length || !text(excerpt, 4000) || body.length > 4000)
      fail(422, "invalid_inbox_share", "Choose nonempty text up to 4,000 characters including the excerpt label.");
    return body;
  }
  const indexes = request.paragraphs;
  if (data.adapter !== "synthetic") fail(409, "channel_sharing_unavailable", "Excerpt sharing is not yet available for this channel.");
  if (indexes.some(i => !Object.hasOwn(data.paragraphs, i))) fail(422, "invalid_inbox_share", "Selected text does not exist.");
  const body = "Shared sample excerpt\n\n" + indexes.map(i => data.paragraphs[i]).join("\n\n");
  if (body.length > 4000) fail(422, "invalid_inbox_share", "Choose at most 4,000 characters including the excerpt label.");
  return body;
};
const replyPreview = (observation, version) => {
  const d = observation?.draft;
  return d ? { version, from: d.from.address, sender: d.sender.address,
    to: d.to.map(a => a.address), cc: d.cc.map(a => a.address), bcc: d.bcc.map(a => a.address),
    subject: d.subject, body: d.body, format: d.format, attachmentState: d.attachmentState,
    attachmentCount: d.attachmentCount, differences: observation.differences } : null;
};

export class Inbox {
  constructor(store, { stitch = null } = {}) {
    this.store = store; this.db = store.db;
    // Cross-channel thread stitching (task #19): stitch is the frozen
    // { salt, epoch, enabled, bindings } triple from stitchConfigFromEnv, or
    // null to leave the stitcher inert (the default). Inert means
    // indexEnvelope no-ops and the read path returns empty stitched views.
    this.stitcher = new InboxStitchStore(this.db, stitch ?? { enabled: false });
    // Notification prefs (quiet hours, per-connection batching — tasks 32/34):
    // store-owned, one manager for every account; the account id doubles as
    // the prefs user id (single-owner account). Preferences UI wiring is a
    // later slice; until then the import path runs the decider on the owner's
    // configured prefs, defaulting to deliver.
    this.notifyPrefs = createNotifyPrefs({ store: new Map() });
  }
  // Cross-channel thread stitching (task #19): in-session participant brief
  // for the review queue. Resolved from the stored envelope at read time —
  // never persisted as a review artifact, so raw handles/addresses never land
  // in the stitch tables.
  stitchParticipantBrief(accountId, sourceId) {
    try {
      const row = this.db.prepare("SELECT * FROM private_inbox_sources WHERE account_id=? AND id=?").get(accountId, sourceId);
      if (!row) return null;
      const data = this.version(accountId, sourceId, row.revision);
      const envelope = data?.envelope ?? null;
      const from = envelope?.message?.from ?? {};
      return { sourceId, channel: envelope?.channel ?? null,
        handle: from.address ?? from.handle ?? from.id ?? "",
        displayName: from.name ?? from.displayName ?? "" };
    } catch { return null; }
  }
  // Cross-channel thread stitching (task #19): owner-only stitch actions.
  // Each runs inside one transaction and reuses the account session, CSRF,
  // and inbox rate limiting from the HTTP layer — no auth behavior changes.
  stitchStatus(token, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding);
      return { contractVersion: 1, viewer: viewer(auth),
        stitching: { enabled: this.stitcher.enabled, epoch: this.stitcher.epoch } };
    });
  }
  stitchSuggestions(token, binding, { limit = 25 } = {}) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding);
      const brief = sourceId => this.stitchParticipantBrief(auth.account.id, sourceId);
      return { contractVersion: 1, viewer: viewer(auth),
        suggestions: this.stitcher.suggestions(auth.account.id, { limit, resolveParticipant: brief }) };
    });
  }
  stitchConfirm(token, binding, { suggestionId } = {}) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding);
      const result = stitchResult(() => this.stitcher.confirm(auth.account.id, { suggestionId, confirmedBy: auth.account.id }));
      return { contractVersion: 1, viewer: viewer(auth), ...result };
    });
  }
  stitchDismiss(token, binding, { suggestionId } = {}) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding);
      const result = stitchResult(() => this.stitcher.dismiss(auth.account.id, { suggestionId }));
      return { contractVersion: 1, viewer: viewer(auth), ...result };
    });
  }
  stitchSplit(token, binding, { stitchKey, sourceId, channel, reason, scope } = {}) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding);
      const result = stitchResult(() => this.stitcher.split(auth.account.id,
        { stitchKey, sourceId, channel, reason, scope }));
      return { contractVersion: 1, viewer: viewer(auth), ...result };
    });
  }
  // Held-message quarantine review UI. The review surface is a pure
  // projection: the journal rows resolve to the imported inbox sources they
  // were quarantined from, and the three review actions write through the
  // journals. Confirming accepts the message back into the inbox (the
  // verdict "not spam"); dismissing drops it from the review backlog as spam
  // and keeps the audit record; splitting separates the source from its
  // native thread. A verdict is a visibility change for the main inbox
  // read paths (quarantinedSourceIds): held and dismissed sources are held
  // out of list/search/threads/read, released sources return — but nothing
  // here moves, mutes, or deletes the imported message itself, and this
  // review surface stays the only view that shows held/dismissed rows.
  quarantineReview(token, binding, { status = "held", limit = null } = {}) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding);
      if (typeof limit === "string") {
        if (!/^\d+$/.test(limit)) fail(422, "invalid_quarantine", "Supply a positive page size.");
        limit = Number(limit);
      }
      if (!spamQuarantineStatuses.includes(status)) fail(422, "invalid_quarantine", "status must be held, released or dismissed");
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail(422, "invalid_quarantine", "Supply a positive page size.");
      // Account scoping: the journal is global, so a hold belongs to this
      // account's review backlog only when it resolves to an imported source
      // in this account. Another account's holds (or a hold whose message is
      // gone) never appear here.
      const items = this.store.spamQuarantine.list({ status, limit: null })
        .map(item => this.quarantineItem(auth, item))
        .filter(item => item.source !== null);
      const counts = { held: 0, released: 0, dismissed: 0 };
      for (const s of spamQuarantineStatuses) {
        if (s === status) { counts[s] = items.length; continue; }
        counts[s] = this.store.spamQuarantine.list({ status: s, limit: null })
          .filter(item => this.quarantineMatch(auth, item) !== null).length;
      }
      return { contractVersion: 1, viewer: viewer(auth), status, counts,
        items: limit === null ? items : items.slice(0, limit) };
    });
  }
  // Review-coverage dashboard for the quarantine review surface (the inline
  // dashboard in the review UI): the same pure computation as the #568
  // read-only tooling (server/quarantine-review-coverage.mjs, --format json
  // output is the drill-down), projected over this account's review backlog.
  // Account scoping is the same quarantineMatch() the review surface uses:
  // another account's holds (or a hold whose message is gone) never shape
  // this account's numbers, exactly like the review listing itself.
  quarantineCoverage(token, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding);
      const rows = [];
      for (const status of spamQuarantineStatuses)
        for (const item of this.store.spamQuarantine.list({ status, limit: null }))
          if (this.quarantineMatch(auth, item) !== null) rows.push(item);
      const splits = new Set(this.store.quarantineSplits.list(auth.account.id).map(split => split.quarantineId));
      return { contractVersion: 1, viewer: viewer(auth), ...reviewCoverageBySignal({ rows, splits }) };
    });
  }
  // The hold the caller's verdict applies to: unknown ids and other
  // accounts' holds both read as not-found from this account's backlog.
  quarantineHold(auth, quarantineId) {
    const hold = this.store.spamQuarantine.get(quarantineId);
    if (!hold || this.quarantineMatch(auth, hold) === null)
      fail(404, "quarantine_not_found", "Quarantine hold not found.");
    return hold;
  }
  quarantineRelease(token, binding, { quarantineId, note = null } = {}) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding);
      this.quarantineHold(auth, quarantineId);
      const reviewer = auth.account.id;
      const item = this.store.spamQuarantine.release(quarantineId, { reviewer, note });
      return { contractVersion: 1, viewer: viewer(auth), decision: "release",
        item: this.quarantineItem(auth, item) };
    });
  }
  quarantineDismiss(token, binding, { quarantineId, note = null } = {}) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding);
      this.quarantineHold(auth, quarantineId);
      const item = this.store.spamQuarantine.dismiss(quarantineId, { reviewer: auth.account.id, note });
      return { contractVersion: 1, viewer: viewer(auth), decision: "dismiss",
        item: this.quarantineItem(auth, item) };
    });
  }
  quarantineSplit(token, binding, { quarantineId, note = null } = {}) {
    return this.store.transaction(() => {
      const auth = this.auth(token, binding), accountId = auth.account.id;
      if (!validId(quarantineId)) fail(422, "invalid_quarantine", "quarantineId must be a string id");
      const hold = this.quarantineHold(auth, quarantineId);
      const source = this.quarantineMatch(auth, hold);
      if (!source) fail(409, "quarantine_source_missing", "The quarantined message is no longer in the inbox.");
      // The thread the source is separated from, for the audit trail. Read
      // before the split records, so the source is still in its native thread.
      const scoped = this.threads(token, binding, { sourceId: source.id, includeChannels: true });
      const priorThread = scoped.threads.find(th => th.entries.some(e => e.source.id === source.id))?.threadId ?? source.id;
      const split = this.store.quarantineSplits.split({ accountId, quarantineId: hold.id,
        sourceId: source.id, priorThread, reviewer: accountId, reason: note });
      return { contractVersion: 1, viewer: viewer(auth), split,
        item: this.quarantineItem(auth, hold) };
    });
  }
  // One review-surface row: the journal verdict metadata plus the resolved
  // imported source. The source match prefers the journal's explicit
  // accountId/sourceId when recorded (gap #2): provider message ids repeat
  // across connections and accounts, so message id + channel alone can
  // collide. Legacy rows without the explicit fields fall back to the
  // connectionId-disambiguated provider-id scan.
  quarantineItem(auth, item) {
    const source = this.quarantineMatch(auth, item);
    // Flatten the source's display fields for the review UI: sender, subject,
    // and excerpt come from the imported message, not the journal row.
    const { sender = null, subject = null } = source ?? {};
    const excerpt = source?.excerpt ?? source?.preview ?? null;
    return { ...item, source, sender, subject, excerpt, shadow: this.quarantineShadow(auth, item) };
  }
  // Shadow enforcement-hold context for the review surface. The source.import
  // receipt journals the shadowQuarantine decision (server/spam-shadow.mjs):
  // wouldHold says whether auto-quarantine would actually have held this
  // message under enforcement, and gateBlock names the first hard gate that
  // blocked it (policy §2.3). The precision report
  // (server/spam-shadow-report.mjs) measures over reviewed WOULD-BE holds,
  // so the reviewer sees exactly which cards the report will count: a
  // dismissed gate-blocked hold is a false_negative ("spam the hold logic
  // missed"), not a true positive. The join uses the journal's explicit
  // accountId/sourceId (gap #2) against the latest import receipt for that
  // source, so re-imports show the current decision. Journal rows filed
  // without an import receipt — pre-instrumentation imports, direct journal
  // writes — get shadow: null: honest absence, not a verdict.
  quarantineShadow(auth, item) {
    try {
      if (!item || !item.sourceId) return null;
      const row = this.db.prepare(`SELECT receipt_json FROM private_inbox_commands
        WHERE account_id=? AND json_extract(request_json,'$.action')='source.import'
        AND json_extract(request_json,'$.sourceId')=?
        ORDER BY sequence DESC LIMIT 1`).get(auth.account.id, item.sourceId);
      if (!row) return null;
      const decision = JSON.parse(row.receipt_json)?.shadowQuarantine ?? null;
      if (!decision || typeof decision !== "object" || typeof decision.wouldHold !== "boolean") return null;
      return Object.freeze({
        policyVersion: typeof decision.policyVersion === "string" ? decision.policyVersion : null,
        threshold: typeof decision.threshold === "number" ? decision.threshold : null,
        wouldHold: decision.wouldHold,
        gateBlock: typeof decision.gateBlock === "string" ? decision.gateBlock : null,
      });
    } catch { return null; }
  }
  quarantineMatch(auth, item) {
    if (!item) return null;
    const accountId = auth.account.id;
    try {
      // Explicit account scope (gap #2, PR #562): a hold filed for another
      // account never resolves into this account's backlog. Legacy rows with
      // accountId null keep the old resolution rules.
      if (item.accountId && item.accountId !== accountId) return null;
      // Explicit source link (gap #2, PR #562): when the import recorded the
      // inbox source id, resolve it directly instead of scanning by provider
      // message id. Legacy rows with sourceId null fall through to the scan.
      if (item.sourceId) {
        let sourceRow;
        try { sourceRow = this.source(accountId, item.sourceId); } catch { return null; }
        const summarized = this.sourceSummary(auth,
          { id: sourceRow.id, revision: sourceRow.revision, updated_at: sourceRow.updated_at },
          { connections: new Map(), include: true, readAt: new Map(), sentIds: new Set() });
        return summarized ? { ...summarized, threadId: null }
          : { id: sourceRow.id, revision: sourceRow.revision, updatedAt: sourceRow.updated_at, threadId: null };
      }
      const rows = this.db.prepare("SELECT id,revision,updated_at FROM private_inbox_sources WHERE account_id=?").all(accountId);
      for (const row of rows) {
        let d;
        try { d = this.version(accountId, row.id, row.revision); } catch { continue; }
        const envelope = d.envelope ?? {}, message = envelope.message ?? {};
        const channelOf = envelope.channel ?? d.adapter ?? null;
        if (channelOf !== item.channel) continue;
        const connectionId = envelope.connection?.id ?? null;
        if (item.connectionId && connectionId !== item.connectionId) continue;
        const providerId = message.id ?? null;
        if (providerId && providerId === item.messageId) {
          const summarized = this.sourceSummary(auth,
            row, { connections: new Map(), include: true, readAt: new Map(), sentIds: new Set() });
          return summarized ? { ...summarized, threadId: null } : { id: row.id, revision: row.revision, updatedAt: row.updated_at, threadId: null };
        }
      }
    } catch { return null; }
    return null;
  }
  // Quarantine visibility enforcement (policy docs/AUTO-QUARANTINE-POLICY.md
  // §1, §3: held is held out of the main inbox, dismissed stays out): the
  // source ids a held or dismissed journal row resolves to. Resolution is
  // the same quarantineMatch() the review surface uses, so the message the
  // owner sees in the review UI is exactly the message the main inbox views
  // (list, search, threads, read, attachment listing + single attachment)
  // hide. Released rows return to the inbox
  // with their flag intact, so they are never in this set. The review
  // surface itself (quarantineReview) stays the only view of held/dismissed
  // rows — nothing here deletes or moves the imported sources.
  quarantinedSourceIds(auth) {
    const ids = new Set();
    // Fast path: counts() is one GROUP BY; when nothing is held or
    // dismissed, skip the per-row source scan entirely.
    const counts = this.store.spamQuarantine.counts();
    for (const status of ["held", "dismissed"]) {
      if (!counts[status]) continue;
      for (const item of this.store.spamQuarantine.list({ status, limit: null })) {
        const source = this.quarantineMatch(auth, item);
        if (source) ids.add(source.id);
      }
    }
    return ids;
  }
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
  // Per-source read markers. A read-only open of a file written before the
  // marker table existed sees no markers: everything reads unread.
  readMarkers(accountId) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='private_inbox_reads'").get()) return new Map();
    return new Map(this.db.prepare("SELECT source_id,read_at FROM private_inbox_reads WHERE account_id=?").all(accountId).map(r => [r.source_id, r.read_at]));
  }
  // Channel sources appear only for a client that negotiated a reading view.
  // One row of the list/search projection, shared by list() and search().
  sourceSummary(auth, row, { connections, include, readAt, sentIds }) {
    const d = this.version(auth.account.id, row.id, row.revision);
    if (d.adapter !== "synthetic" && !include) return null;
    const profile = d.adapter === "synthetic" ? null : d.envelope.connection;
    if (profile && !connections.has(profile.id)) {
      const saved = this.store.email.connection(auth.account.id, profile.id);
      connections.set(profile.id, { id: profile.id, channel: profileChannel(profile), provider: profile.provider,
        state: saved ? connectionState(saved, auth.account.authEpoch) : "disconnected" });
    }
    const gmail = profile?.provider === 'gmail-api' && connections.get(profile.id)?.state === 'active';
    const folder = gmail ? this.store.connections.folder(auth.account.id, profile.id, 'INBOX') : null;
    if (folder && !folder.members.includes(d.envelope.message.id)) return null;
    return { id: row.id, revision: row.revision, adapter: d.adapter, ...summary(d), updatedAt: row.updated_at,
      readAt: gmail ? (d.envelope.message.isRead ? row.updated_at : null) : readAt.get(row.id) ?? null, connection: profile ? connections.get(profile.id) : null,
      needsYou: inboxNeedsYou(d, sentIds) };
  }
  list(token, binding, { includeChannels = false, includeEmail = false, cursor = null, limit = null } = {}) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding), connections = new Map(), include = includeChannels || includeEmail;
      const take = pageLimitOf(limit), after = decodeCursor(cursor);
      const ctx = { connections, include, readAt: this.readMarkers(auth.account.id),
        sentIds: include ? this.sentProviderIds(auth.account.id) : new Set() };
      const params = [auth.account.id];
      let sql = "SELECT * FROM private_inbox_sources WHERE account_id=?";
      if (after) { sql += " AND (updated_at < ? OR (updated_at = ? AND id > ?))"; params.push(after.updatedAt, after.updatedAt, after.id); }
      sql += " ORDER BY updated_at DESC,id LIMIT ?";
      params.push(take + 1);
      const rows = this.db.prepare(sql).all(...params);
      const hasMore = rows.length > take, page = hasMore ? rows.slice(0, take) : rows;
      // Quarantine visibility enforcement: held and dismissed sources are
      // held out of the list. The cursor stays on the raw page (it already
      // can point past invisible channel rows), so pagination semantics are
      // unchanged — a page may simply return fewer visible sources.
      const quarantined = this.quarantinedSourceIds(auth);
      const sources = page.map(row => this.sourceSummary(auth, row, ctx))
        .filter(summary => summary && !quarantined.has(summary.id));
      const last = page[page.length - 1];
      return { contractVersion: 1, viewer: viewer(auth), sources,
        nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null };
    });
  }
  // Full-text search over an account's visible sources, backed by the pure
  // index in server/inbox-search.mjs. Mirrors list()'s visibility rule:
  // channel sources appear only for a client that negotiated a reading view.
  // Results carry list()'s source shape plus a BM25 score, best first.
    // Threading keys for one visible source. Email groups by conversation
    // (threadId) with replies resolved through internetMessageId; channel
    // sources group by their threadId with replies resolved through the
    // channel's own message ids. Synthetic samples have no thread metadata
    // and form singletons keyed by their own id.
    threadKeyOf(info, replyIndex) {
      const { row, adapter } = info;
      const fallback = () => ({ id: row.id, occurredAt: new Date(row.updated_at).toISOString(), threadId: null, inReplyTo: null });
      try {
        if (adapter === "email") {
          const envelope = readEmailEnvelope(info.envelope);
          const occurredAt = envelope.message.receivedAt ?? envelope.message.sentAt;
          // The reply index is namespaced by connection id, like the thread
          // id below: an internetMessageId is only unique per mailbox, so a
          // duplicated or malformed value on one connection must never
          // cross-parent threads imported through another connection.
          const connectionId = envelope.connection.id;
          const parent = envelope.replyHeaders.inReplyTo.map(id => replyIndex.get(`email:${connectionId}:${id}`)).find(Boolean);
          // Provider thread ids are only unique per connection: namespace so
          // the same id on two connections (or two providers) never merges
          // unrelated conversations.
          const threadId = envelope.message.threadId == null ? null
            : `email:${envelope.connection.id}:${envelope.message.threadId}`;
          return { id: row.id, occurredAt, threadId, connectionId,
            inReplyTo: parent ?? null, internetId: envelope.message.internetMessageId };
        }
        if (adapter !== "synthetic") {
          const envelope = readChannelEnvelope(info.envelope), message = envelope.message;
          const occurredAt = typeof message.sentAt === "string" ? message.sentAt : new Date(row.updated_at).toISOString();
          const replyTo = typeof message.replyTo === "string" ? replyIndex.get(envelope.channel + ":" + message.replyTo) : null;
          // Same namespacing as the reply index: a bare provider thread id can
          // collide across channels (e.g. numeric chat ids).
          const threadId = typeof message.threadId === "string" ? `${envelope.channel}:${message.threadId}` : null;
          return { id: row.id, occurredAt, threadId, inReplyTo: replyTo ?? null, channelId: typeof message.id === "string" ? message.id : null };
        }
        return fallback();
      } catch {
        return fallback();
      }
    }
    threadPipeline(auth, { sourceId = null, include = false } = {}) {
      // A scoped lookup names an existing source in this account (404 when
      // unknown, 422 when malformed); the thread returned is the full
      // conversation containing it, built from the same visible set as the
      // unscoped view. When the source is not visible in this view (a
      // channel source without a reading view, or a malformed version),
      // the scope matches nothing and the result is empty.
      if (sourceId) this.source(auth.account.id, sourceId);
      const rows = this.db.prepare("SELECT * FROM private_inbox_sources WHERE account_id=? ORDER BY updated_at DESC,id LIMIT 5000").all(auth.account.id);
      const rawInfos = [];
      for (const row of rows) {
        try {
          const d = this.version(auth.account.id, row.id, row.revision);
          if (d.adapter !== "synthetic" && !include) continue;
          rawInfos.push({ row, adapter: d.adapter, envelope: d.envelope, channel: d.envelope?.channel ?? null });
        } catch { /* malformed version: skip, never break the thread view */ }
      }
      // Quarantine visibility enforcement: held and dismissed sources are
      // excluded before threading, so they never appear in a thread — not
      // as entries and not as reply parents. The review surface is the
      // only view that shows them.
      const quarantined = this.quarantinedSourceIds(auth);
      const infos = rawInfos.filter(info => !quarantined.has(info.row.id));
      const replyIndex = new Map();
      const keys = infos.map(info => this.threadKeyOf(info, replyIndex));
      for (const [info, key] of infos.map((info, i) => [info, keys[i]])) {
        if (key.internetId && key.connectionId) replyIndex.set(`email:${key.connectionId}:${key.internetId}`, key.id);
        if (key.channelId && info.channel) replyIndex.set(info.channel + ":" + key.channelId, key.id);
      }
      // Re-resolve replies now that the index is complete (targets may sort after the reply).
      // Quarantine review splits: a split source is forced into its own
      // singleton thread at read time. The stored provider thread and
      // reply keys are untouched — only the grouping key changes, so the
      // rest of the conversation keeps its native thread.
      const splitIds = this.store.quarantineSplits.splitSourceIds(auth.account.id);
      const messages = infos.map((info, i) => {
        const key = this.threadKeyOf(info, replyIndex);
        if (splitIds.has(info.row.id)) return { id: key.id, occurredAt: key.occurredAt,
          threadId: `quarantine-split:${info.row.id}`, inReplyTo: null };
        return { id: key.id, occurredAt: key.occurredAt, threadId: key.threadId, inReplyTo: key.inReplyTo };
      });
      const built = buildThreads(messages);
      const scoped = sourceId
        ? built.filter(thread => thread.entries.some(entry => entry.message.id === sourceId))
        : built;
      return { rows, infos, scoped, infosById: new Map(infos.map(info => [info.row.id, info])) };
    }
        threads(token, binding, { sourceId = null, limit = null, includeChannels = false } = {}) {
      return this.store.readTransaction(() => {
        const auth = this.auth(token, binding), take = threadLimitOf(limit);
        const include = includeChannels === true;
        const { rows, infos, scoped, infosById } = this.threadPipeline(auth, { sourceId, include });
        const ctx = { connections: new Map(), include, readAt: this.readMarkers(auth.account.id),
          sentIds: include ? this.sentProviderIds(auth.account.id) : new Set() };
        const byId = new Map(rows.map(row => [row.id, row]));
        const threads = scoped.slice(0, take).map(thread => ({
          threadId: thread.threadId, messageCount: thread.messageCount, depth: thread.depth,
          firstAt: thread.firstAt, lastAt: thread.lastAt,
          // Per-channel SLA clock, inline in the thread list (task 24): an
          // additive field; null when the thread carries nothing to clock.
          sla: this.slaAssessment(infosById, thread, ctx.sentIds),
          entries: thread.entries
            .map(({ message, depth }) => ({ depth, source: this.sourceSummary(auth, byId.get(message.id), ctx) }))
            .filter(entry => entry.source)
        })).filter(thread => thread.entries.length > 0);
        // Cross-channel thread stitching (task #19): stitched timelines are a
        // read-path enrichment over the same native threads. The native
        // `threads` contract is unchanged; `stitchedThreads` is additive, and
        // empty while the stitcher is inert (no salt / flag off).
        const channelById = new Map(infos.map(info => [info.row.id, info.channel ?? null]));
        const stitchedThreads = this.stitcher.stitchedTimelines(auth.account.id,
          scoped.slice(0, take).map(thread => ({ threadId: thread.threadId,
            entries: thread.entries.map(({ message }) => ({ sourceId: message.id, occurredAt: message.occurredAt })) })),
          { channelOf: sourceId => channelById.get(sourceId) ?? null })
          .map(st => ({ ...st, entries: st.entries
            .map(entry => ({ ...entry, source: this.sourceSummary(auth, byId.get(entry.sourceId), ctx) }))
            .filter(entry => entry.source) }))
          .filter(st => st.entries.length > 0);
        return { contractVersion: 1, viewer: viewer(auth), threads, stitchedThreads, total: scoped.length };
      });
    }
    slaClockInput(infosById, thread, sentIds) {
      const addressOf = value => (value?.address ?? "").toLowerCase();
      const directionOf = info => {
        try {
          if (info.adapter === "email") {
            const envelope = readEmailEnvelope(info.envelope);
            const own = new Set([envelope.connection.identity, ...(envelope.connection.aliases ?? [])].map(addressOf));
            const from = addressOf(envelope.message.from);
            if (own.has(from)) return "outbound";
            return envelope.message.to.some(a => own.has(addressOf(a))) ? "inbound" : "skip";
          }
          if (info.adapter !== "synthetic") {
            const envelope = readChannelEnvelope(info.envelope);
            const identity = envelope.connection?.identity, from = envelope.message?.from;
            if (from && identity && String(from.id) === String(identity.id)) return "outbound";
            return inboxNeedsYou({ adapter: info.adapter, envelope: info.envelope }, sentIds) ? "inbound" : "skip";
          }
        } catch { /* malformed envelope: skip, never break the thread view */ }
        return "skip";
      };
      const channelCounts = new Map(), messages = [];
      for (const entry of thread.entries) {
        const info = infosById.get(entry.message.id);
        if (!info) continue;
        const channel = info.adapter === "email" ? "email" : info.channel;
        if (channel) channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
        const direction = directionOf(info);
        if (direction === "skip") continue;
        messages.push({ id: entry.message.id, occurredAt: entry.message.occurredAt, direction });
      }
      if (!messages.length || !channelCounts.size) return null;
      const channel = [...channelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { threadId: thread.threadId ?? "thread:" + messages[0].id, channel, messages };
    }
    // Per-channel SLA assessment for one built thread: the clock input run
    // through assessThreadSla. Null when the thread carries nothing to clock.
    slaAssessment(infosById, thread, sentIds) {
      const input = this.slaClockInput(infosById, thread, sentIds);
      if (!input) return null;
      try {
        return assessThreadSla({ ...input, now: Date.now(), targets: slaTargets });
      } catch { return null; } // clock skew (now < latest inbound): omit rather than lie
    }
    // SLA sweep thread scan (task 26): the assess-shaped thread list the
    // SlaSweeper's readThreads hook enumerates. Rides threadPipeline, so the
    // sweep clocks exactly the threads the thread view shows — same store,
    // same visibility, same message->direction mapping. Owner-session bound
    // like the thread view; an empty store honestly scans to zero threads,
    // never invented ones. includeChannels defaults true: the sweep is
    // omnichannel, and channel rows still need the negotiated reading view.
    // The bound is the sweep producer's 10000-thread contract, not the UI
    // thread list's page cap — the sweep must see every open thread.
    slaThreadScan(token, binding, { includeChannels = true, limit = null } = {}) {
      return this.store.readTransaction(() => {
        const auth = this.auth(token, binding);
        const take = limit === null || limit === undefined ? 10000
          : (Number.isInteger(limit) && limit >= 1 && limit <= 10000 ? limit
            : fail(422, "invalid_limit", "limit must be an integer 1..10000"));
        const include = includeChannels === true;
        const { scoped, infosById } = this.threadPipeline(auth, { include });
        const sentIds = include ? this.sentProviderIds(auth.account.id) : new Set();
        const threads = [];
        for (const thread of scoped.slice(0, take)) {
          const input = this.slaClockInput(infosById, thread, sentIds);
          if (input) threads.push(Object.freeze({ threadId: input.threadId, channel: input.channel,
            messages: Object.freeze(input.messages.map(message => Object.freeze({ ...message }))) }));
        }
        return Object.freeze({ contractVersion: 1, viewer: viewer(auth),
          threads: Object.freeze(threads), total: scoped.length });
      });
    }
    // SLA dashboard (task 26): response-time percentiles, breach counts, and
    // the end-of-day open-conversation sweep ("nothing closes unowned"),
    // across Telegram and email. On-demand read over the same thread scan
    // the sweep uses, the same clocks the inbox list shows, and the open
    // handoff journal for ownership — never a push. Ownership: a thread with
    // an open handoff (journaled receipt, task 23) is someone's; everything
    // else awaiting a reply is unowned and lands in the sweep.
    slaDashboard(token, binding, { now = null } = {}) {
      const at = now === null || now === undefined ? Date.now() : now;
      const view = this.slaThreadScan(token, binding, { includeChannels: true });
      const auth = this.auth(token, binding);
      const owners = new Map();
      for (const handoff of this.store.handoffs.list(auth.account.id, { status: "open" }))
        owners.set(handoff.threadId, handoff.toAgent);
      const alerts = this.store.slaBreachAlerts.list(auth.account.id, {});
      return { contractVersion: 1, viewer: view.viewer,
        dashboard: buildSlaDashboard({ threads: view.threads, now: at,
          targets: slaTargets, owners, breachAlerts: alerts }) };
    }
    // Attachment descriptors for one source. Descriptors are metadata only: the
    // system never retains attachment bytes, so this is a listing and a
    // membership check, not a download. Byte retrieval needs a live provider
    // fetch with the account's credentials; that future slice reuses this
    // auth + ownership + membership path.
    attachmentDescriptors(d) {
      if (d.adapter === "email") {
        return readEmailEnvelope(d.envelope).attachments.items
          .map(a => ({ id: a.id, kind: a.kind, name: a.name, contentType: a.contentType, size: a.size, inline: a.inline }));
      }
      if (d.adapter !== "synthetic") {
        return readChannelEnvelope(d.envelope).attachments
          .map(a => ({ id: a.id, kind: a.kind, name: a.name, contentType: a.contentType, size: a.size, inline: false }));
      }
      return [];
    }
    attachments(token, binding, { sourceId, includeChannels = false } = {}) {
      return this.store.readTransaction(() => {
        const auth = this.auth(token, binding), row = this.source(auth.account.id, sourceId);
        const d = this.version(auth.account.id, row.id, row.revision);
        if (d.adapter !== "synthetic" && includeChannels !== true) fail(404, "inbox_source_not_found", "Source not found.");
        // Quarantine visibility enforcement (residual from #564): attachment
        // descriptors for a held or dismissed source must not surface — same
        // 404 shape as the read path, so no metadata and no hint of the hold
        // leaks through this listing.
        if (this.quarantinedSourceIds(auth).has(sourceId)) fail(404, "inbox_source_not_found", "Source not found.");
        return { contractVersion: 1, viewer: viewer(auth), sourceId: row.id, attachments: this.attachmentDescriptors(d) };
      });
    }
    attachment(token, binding, { sourceId, attachmentId, includeChannels = false } = {}) {
      return this.store.readTransaction(() => {
        const auth = this.auth(token, binding), row = this.source(auth.account.id, sourceId);
        const d = this.version(auth.account.id, row.id, row.revision);
        if (d.adapter !== "synthetic" && includeChannels !== true) fail(404, "inbox_source_not_found", "Source not found.");
        // Quarantine visibility enforcement (residual from #564): the single-
        // attachment membership check is gated on the same quarantine check
        // as the listing, so a held message's attachment id can neither be
        // confirmed nor probed through this path.
        if (this.quarantinedSourceIds(auth).has(sourceId)) fail(404, "inbox_source_not_found", "Source not found.");
        const found = this.attachmentDescriptors(d).find(a => a.id === attachmentId);
        if (!found) fail(404, "inbox_attachment_not_found", "Attachment not found.");
        return { contractVersion: 1, viewer: viewer(auth), sourceId: row.id, attachment: found,
          retrieval: { available: false, reason: "attachment_bytes_not_retained",
            detail: "Descriptors are metadata only. Byte retrieval needs a live provider fetch with the account's credentials." } };
      });
    }
  search(token, binding, { query = null, sourceId = null, limit = null, includeChannels = false } = {}) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding);
      if (typeof query !== "string" || !query.trim() || query.length > 500) fail(422, "invalid_search_query", "Supply a search query up to 500 characters.");
      const take = searchLimitOf(limit), include = includeChannels;
      const rows = this.db.prepare("SELECT * FROM private_inbox_sources WHERE account_id=? ORDER BY updated_at DESC,id LIMIT 5000").all(auth.account.id);
      const byId = new Map(rows.map(row => [row.id, row]));
      // Quarantine visibility enforcement: held and dismissed sources are
      // excluded from the search index before the query runs, so totals and
      // results only ever reflect visible sources.
      const quarantined = this.quarantinedSourceIds(auth);
      const messages = [];
      for (const row of rows) {
        if (sourceId && row.id !== sourceId) continue;
        if (quarantined.has(row.id)) continue;
        const d = this.version(auth.account.id, row.id, row.revision);
        if (d.adapter !== "synthetic" && !include) continue;
        const body = searchText(d);
        if (body.trim()) messages.push({ id: row.id, subject: summary(d).subject ?? "", body });
      }
      const hits = runInboxSearch(indexMessages(messages), query, { limit: take });
      const ctx = { connections: new Map(), include, readAt: this.readMarkers(auth.account.id),
        sentIds: include ? this.sentProviderIds(auth.account.id) : new Set() };
      const results = hits.results
        .map(({ message, score }) => ({ source: this.sourceSummary(auth, byId.get(message.id), ctx), score }))
        .filter(result => result.source);
      return { contractVersion: 1, viewer: viewer(auth), query: hits.query.trim(), results, total: hits.total };
    });
  }
  read(token, sourceId, binding, { emailView = false, excerptView = false } = {}) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding), row = this.source(auth.account.id, sourceId);
      // Quarantine visibility enforcement: a held or dismissed source reads
      // as not-found, exactly like an unknown source — no content and no
      // hint of the hold leaks through the read path. The review surface is
      // where quarantined messages are viewed.
      if (this.quarantinedSourceIds(auth).has(sourceId)) fail(404, "inbox_source_not_found", "Source not found.");
      const draft = this.db.prepare("SELECT revision,source_revision,body,updated_at FROM private_inbox_drafts WHERE account_id=? AND source_id=?").get(auth.account.id, sourceId);
      const data = this.version(auth.account.id, row.id, row.revision);
      const source = emailView && data.adapter === "email" ? this.emailView(auth, row, data.envelope, excerptView)
        : emailView && data.adapter === "telegram" ? this.channelView(auth, row, data.envelope, excerptView) : { id: row.id, revision: row.revision, ...data };
      source.readAt = this.readMarkers(auth.account.id).get(sourceId) ?? null;
      return { contractVersion: 1, viewer: viewer(auth), source,
        draft: draft ? { revision: draft.revision, sourceRevision: draft.source_revision, body: draft.body, updatedAt: draft.updated_at,
          origin: this.draftOrigin(auth.account.id, sourceId, draft.body, row.revision) } : null };
    });
  }
  emailView(auth, row, value, excerptView = false) {
    const envelope = readEmailEnvelope(value), { message, body, attachments } = envelope;
    const saved = this.db.prepare("SELECT data_json FROM private_email_connections WHERE account_id=? AND id=?")
      .get(auth.account.id, envelope.connection.id);
    if (!saved || envelope.connection.accountId !== auth.account.id) fail(409, "channel_connection_unavailable", "Connection unavailable.");
    const connection = JSON.parse(saved.data_json);
    // A bounded, inert reading projection, never a provider/send envelope. Keep
    // cursors, headers, HTML, attachment descriptors and mailbox IDs off this path.
    return { id: row.id, revision: row.revision, adapter: "email", sender: message.from.address,
      recipient: envelope.connection.identity.address, subject: message.subject,
      paragraphs: body.format === "text" ? [excerptView ? emailSelectionText(body) : body.content] : [],
      capabilities: { draft: true, share: excerptView && body.format === "text" && Boolean(body.content.trim()), send: false },
      needsYou: inboxNeedsYou({ adapter: "email", envelope }),
      email: { view: excerptView ? "email-excerpt-v1" : "email-text-v1", accountId: auth.account.id, format: body.format,
        connectionState: connectionState(connection, auth.account.authEpoch),
        to: message.to.map(a => a.address), cc: message.cc.map(a => a.address), bcc: message.bcc.map(a => a.address),
        attachmentState: attachments.state, attachmentCount: attachments.items.length } };
  }
  // Telegram reading projection: text, participants and attachment counts only.
  // No file ids, chat ids, update cursors or bot identifiers reach the browser.
  channelView(auth, row, value, excerptView = false) {
    const envelope = readChannelEnvelope(value), { message, body, attachments, connection: profile } = envelope;
    const saved = this.store.email.connection(auth.account.id, profile.id);
    if (!saved || profile.accountId !== auth.account.id) fail(409, "channel_connection_unavailable", "Connection unavailable.");
    const content = excerptView ? emailSelectionText(body) : body.content, state = connectionState(saved, auth.account.authEpoch);
    // `send` is the adapter capability on an active connection; whether this
    // deployment has a transport for it is reported by the send routes.
    return { id: row.id, revision: row.revision, adapter: envelope.channel, ...summary({ adapter: envelope.channel, envelope }),
      paragraphs: [content], capabilities: { draft: true, share: excerptView && Boolean(content.trim()), send: state === "active" && profile.capabilities.send === true },
      needsYou: inboxNeedsYou({ adapter: envelope.channel, envelope }, this.sentProviderIds(auth.account.id)),
      channel: { view: excerptView ? "channel-excerpt-v1" : "channel-text-v1", accountId: auth.account.id, channel: envelope.channel, provider: profile.provider,
        connectionState: state, format: body.format, kind: message.kind, edited: message.editedAt !== null,
        chat: participantLabel(message.to[0]), attachmentCount: attachments.length } };
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
  // Provider ids of replies the account's connections actually sent.
  sentProviderIds(accountId) {
    return new Set([...this.outbox(accountId).values()].filter(s => s.providerId !== null && ["accepted", "delivered"].includes(s.status)).map(s => s.providerId));
  }
  // Which connection a channel source belongs to, for server-side transport
  // selection only. Synthetic samples have none.
  sourceConnection(token, sourceId, binding) {
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding), row = this.source(auth.account.id, sourceId), data = this.version(auth.account.id, row.id, row.revision);
      if (data.adapter === "synthetic") return null;
      const saved = this.store.email.connection(auth.account.id, data.envelope.connection.id);
      return { adapter: data.adapter, connectionId: data.envelope.connection.id, provider: data.envelope.connection.provider,
        state: saved ? connectionState(saved, auth.account.authEpoch) : "disconnected", send: data.envelope.connection.capabilities?.send === true };
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
  replyBaseAttempt(accountId, attempt) {
    if (!attempt?.providerDraftId) return attempt;
    const read = this.latestReplyRead(accountId, attempt.id);
    return read ? replyAttemptWithObservation(attempt, read.observation) : attempt;
  }
  latestReplyRead(accountId, attemptId) {
    const row = this.db.prepare("SELECT request_json FROM private_inbox_commands WHERE account_id=? AND json_extract(request_json,'$.action') IN ('reply.observed','reply.update.observed','reply.update.inspected') AND json_extract(request_json,'$.attemptId')=? ORDER BY sequence DESC LIMIT 1").get(accountId, attemptId);
    return row ? JSON.parse(row.request_json) : null;
  }
  replyUpdateContext(token, sourceId, updateId, binding) {
    const auth = this.auth(token, binding), { source, draft } = this.read(token, sourceId, binding);
    const updates = [...this.replyUpdateHistory(auth.account.id, sourceId).values()].filter(u => u.status !== "cancelled");
    const update = updates.at(-1);
    if (!update || update.id !== updateId) fail(409, "stale_reply_update", "Choose the current reply update.");
    const attempt = this.replyHistory(auth.account.id, sourceId).get(update.attemptId);
    const connection = source.adapter === "email" ? this.store.email.connection(auth.account.id, source.envelope.connection.id) : null;
    return { auth, source, draft, connection, attempt, update };
  }
  prepareReplyUpdateInspection(token, sourceId, updateId, binding) {
    return this.store.readTransaction(() => buildUpdateInspection(this.replyUpdateContext(token, sourceId, updateId, binding)));
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
      if ([...this.replyUpdateHistory(attempt.plan.accountId, attempt.sourceId).values()].some(u => u.attemptId === attempt.id && u.status !== "cancelled")) return false;
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
    if (!["reply-review-v1", "reply-review-v2", "reply-review-v3", "reply-review-v4"].includes(view)) fail(422, "unsupported_inbox_view", "Choose the supported reply review.");
    return this.store.readTransaction(() => {
      const auth = this.auth(token, binding); this.source(auth.account.id, sourceId);
      const prior = [...this.replyHistory(auth.account.id, sourceId).values()].find(value => value.status !== "cancelled");
      let attempt = null;
      if (prior) {
        const current = this.replyPlanCurrent(token, prior, binding);
        const o = prior.observation;
        attempt = { id: prior.id, revision: prior.revision, status: prior.status, sourceRevision: prior.plan.sourceRevision,
          draftRevision: prior.plan.draftRevision, canSend: false, canReview: current && replyObservationReviewable(o),
          observation: replyPreview(o, o?.reviewVersion),
          review: prior.review ? { version: prior.review.version, at: prior.review.at,
            current: current && prior.review.authEpoch === auth.account.authEpoch } : null };
      }
      const value = { contractVersion: 1, view, viewer: viewer(auth), sourceId, attempt };
      if (view !== "reply-review-v1") {
        const update = prior && [...this.replyUpdateHistory(auth.account.id, sourceId).values()].filter(u => u.attemptId === prior.id && u.status !== "cancelled").at(-1);
        // v2 knows only unresolved completion; v3 can distinguish the write
        // acknowledgment from the still-pending content review.
        const status = update?.status === "resolved" && view !== "reply-review-v4" ? "update_acknowledged" : update?.status ?? null;
        value.comparison = prior ? { originalBody: prior.plan.expected.body,
          updateStatus: view === "reply-review-v2" && status === "update_acknowledged" ? "update_unconfirmed" : status } : null;
        if (view === "reply-review-v4") {
          value.update = null;
          if (update) {
            const context = this.replyUpdateContext(token, sourceId, update.id, binding);
            let review = null;
            try { review = buildUpdateReview(context); }
            catch (error) { if (!(error instanceof ServiceError) && !(error instanceof EmailContractError)) throw error; }
            // Reading the sheet must not resurrect an older child snapshot after
            // a newer parent read (including unavailable). This display does not
            // grant child review authority; buildUpdateReview still qualifies it.
            const read = this.latestReplyRead(auth.account.id, prior.id);
            const o = read ? compareReplyUpdateEnvelope({ ...update.proposal,
              connection: read.observation?.connection ?? update.proposal.connection }, read.observation)
              : update.observation ?? prior.observation, d = o?.draft;
            const version = review?.reviewVersion ?? update.inspection?.version ?? (o ? digest(o) : null);
            value.update = { id: update.id, attemptId: prior.id, revision: update.revision, status: update.status,
              sourceRevision: context.source.revision, draftRevision: context.draft?.revision ?? 0,
              canSend: false, canReview: Boolean(review?.canReview),
              versionMismatch: Boolean(update.acknowledgment && d && d.revision !== update.acknowledgment.providerRevision),
              observation: replyPreview(o, version),
              review: update.review?.version === version ? { version, at: update.review.at,
                current: Boolean(review?.canReview && update.review.authEpoch === auth.account.authEpoch) } : null };
          }
        }
      }
      return value;
    });
  }
  // Narrow human acknowledgment boundary. Never expose provider/dispatch writes.
  reviewReply(token, request, binding) {
    if (request?.action === "reply.update.review") {
      const result = this.reply(token, request, binding), { update, ...receipt } = result.receipt;
      return { ...result, receipt: { ...receipt, attemptId: update.attemptId, updateId: update.id,
        revision: update.revision, reviewVersion: update.review.version } };
    }
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
  recordReplyUpdateInspection(token, { context, requestId, response }, binding) {
    return this.store.transaction(() => {
      this.auth(token, binding);
      if (!context || typeof context !== "object" || !context.connection) fail(422, "invalid_reply_inspection", "Prepare a mailbox inspection first.");
      const { sourceId, attemptId, updateId, expectedRevision, inspectionVersion } = context;
      return this.reply(token, { action: "reply.update.inspected", requestId, sourceId, attemptId, updateId,
        expectedRevision, inspectionVersion, connectionRevision: context.connection.revision,
        observation: normalizeReplyObservation({ connection: context.connection }, response) }, binding);
    });
  }
  // Trusted, transaction-bound importer only. Ordinary HTTP commands cannot use it.
  importSource(token, request, binding) {
    if (!this.db.isTransaction || request?.action !== "source.import") fail(403, "channel_importer_required", "Use the transactional channel importer.");
    return this.apply(token, request, binding, importAuthority);
  }
  apply(token, request, binding, authority = null) {
    return this.store.transaction(() => {
      const auth = (authority === importAuthority ? gmailImportAuth(this.store, token, request) : null) ?? this.auth(token, binding); validate(request);
      if (isReplyAttempt(request) && authority !== replyAuthority) fail(403, "reply_driver_required", "Use the configured reply driver.");
      if (internalSend(request) && authority !== transportAuthority) fail(403, "inbox_transport_required", "Only the configured transport can record this outcome.");
      if (request.action === "source.import" && authority !== importAuthority) fail(403, "channel_importer_required", "Only the configured importer can record this source.");
      if (request.action === "source.import" && request.data.envelope.connection.accountId !== auth.account.id)
        fail(403, "channel_account_mismatch", "Observation belongs to another account.");
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
        const proposal = (action === "reply.update.reserve" || action === "reply.update.dispatch" && prior?.status === "reserved") ? prepareGraphReplyUpdate({ store: this.store, token, binding,
          sourceId, attemptId: request.attemptId, requestId: action === "reply.update.reserve" ? requestId : prior?.proposal.requestId,
          expectedRevision: action === "reply.update.reserve" ? request.expectedRevision : prior?.proposal.attemptRevision }) : null;
        const dispatch = action === "reply.update.acknowledged"
          ? this.db.prepare("SELECT receipt_json FROM private_inbox_commands WHERE account_id=? AND request_id=?").get(accountId, request.dispatchRequestId) : null;
        const context = ["reply.update.inspected", "reply.update.review"].includes(action)
          ? this.replyUpdateContext(token, sourceId, request.updateId, binding) : null;
        receipt.update = transitionReplyUpdate(updates, request, { proposal, dispatch: dispatch && JSON.parse(dispatch.receipt_json),
          inspection: action === "reply.update.inspected" ? buildUpdateInspection(context) : null,
          review: action === "reply.update.review" ? buildUpdateReview(context) : null, at: now });
      } else if (isReplyAttempt(request)) {
        this.source(accountId, sourceId);
        const attempts = this.replyHistory(accountId), original = attempts.get(request.attemptId);
        if (action === "reply.review" && [...this.replyUpdateHistory(accountId).values()].some(u => u.attemptId === request.attemptId && u.status !== "cancelled"))
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
        // Cross-channel thread stitching (task #19): hash-only identity
        // indexing for the imported envelope. The try/catch keeps the
        // comment below honest — a stitch failure never rolls back the
        // import (stitching never blocks ingestion).
        if (request.action === "source.import") {
          try {
            this.stitcher.indexEnvelope(accountId, request.data.envelope, { sourceId });
          } catch { /* stitching is read-path enrichment; ingestion proceeds */ }
          // Spam guard + quiet hours (tasks 32/34): the pure scorer and the
          // notify decider run on every imported envelope. The spam flag is a
          // pure function of the envelope; the decision journals the prefs
          // snapshot it ran on, so Inbox.verify() replays both
          // deterministically. Flag-only (task 33): nothing is held, hidden,
          // or moved here — the scores are recorded on the receipt.
          Object.assign(receipt, runImportGuards({ prefs: this.notifyPrefs, accountId,
            envelope: request.data.envelope, at: now }));
          // Shadow-mode auto-quarantine instrumentation (policy §5, 14-day
          // shadow): log what WOULD have been held under the v1 hold
          // threshold, with the §2.3 gates evaluated from the envelope. A pure
          // function of journaled inputs (flag + envelope + at), so the
          // journal replay recomputes it identically below. One decision per
          // scored message, wouldHold true or false — flag-only behavior is
          // unchanged: nothing is held, hidden, or moved here.
          Object.assign(receipt, { shadowQuarantine: shadowDecisionForImport({ flag: receipt.spam,
            envelope: request.data.envelope, at: now }) });
          // Durable spam quarantine: when the flag trips, file the message in
          // the restart-surviving spam_quarantine journal (store.spamQuarantine)
          // for owner review — never the in-memory createQuarantineQueue, which
          // loses its queue on restart. The journal's review() speaks the same
          // release|confirm_spam decision vocabulary as the queue, so the
          // review flow is unchanged. The import itself is untouched: the
          // message still lands in the inbox (flag-only, task 33) — the journal
          // is the review backlog, riding the same store transaction as the
          // receipt (a duplicate requestId short-circuits above, so retries
          // never double-journal). Journaling never blocks ingestion,
          // mirroring the stitch try/catch above.
          if (receipt.spam?.quarantine) {
            try {
              this.store.spamQuarantine.quarantine({
                messageId: request.data.envelope.message?.id,
                channel: request.data.envelope.channel,
                connectionId: request.data.envelope.connection?.id ?? null,
                // Gap #2 (PR #562): the hold records the importing account
                // and the inbox source it was filed from, so identical
                // provider message/channel/connection ids across accounts are
                // no longer ambiguous on the review surface.
                accountId, sourceId,
                flag: { score: receipt.spam.score, signals: receipt.spam.signals, quarantine: true },
                at: now,
              });
            } catch { /* quarantine journaling never blocks ingestion */ }
          }
        }
      } else if (["source.read", "source.unread"].includes(action)) {
        // Read state is a marker, not a content version: the source revision
        // never moves, only the marker's read_at does. expectedRevision is the
        // source revision the caller saw, so a concurrent import races stale.
        const source = this.source(accountId, sourceId);
        if (source.revision !== request.expectedRevision) fail(409, "stale_inbox_source", "Source changed. Review the current version.");
        Object.assign(receipt, { sourceRevision: source.revision, readAt: action === "source.read" ? now : null });
        if (action === "source.read") {
          this.db.prepare(`INSERT INTO private_inbox_reads(account_id,source_id,read_at) VALUES(?,?,?)
            ON CONFLICT(account_id,source_id) DO UPDATE SET read_at=excluded.read_at`).run(accountId, sourceId, now);
        } else {
          this.db.prepare("DELETE FROM private_inbox_reads WHERE account_id=? AND source_id=?").run(accountId, sourceId);
        }
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
    // The read-marker table is purely additive (a read-only open of a file
    // written before it existed sees no markers): verify its shape and rows
    // only when it is present.
    const readsSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='private_inbox_reads'").get()?.sql;
    if (readsSchema !== undefined) require(normalize(readsSchema) === normalize(inboxReadSchema.replace("IF NOT EXISTS ", "")));
    const sources = new Map(), drafts = new Map(), historicalRooms = new Map(), outboxes = new Map(), replyBoxes = new Map(), updateBoxes = new Map(), dispatches = new Map(), replyReads = new Map(), reads = new Map(); let versions = 0;
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
        let plan = null, proposal = null, inspection = null, review = null;
        const readKey = canonical([row.account_id, request.attemptId]);
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
          if (isReplyUpdate(request)) proposal = buildGraphReplyUpdate({ ...context,
            attempt: replyReads.has(readKey) ? replyAttemptWithObservation(original, replyReads.get(readKey)) : original,
            requestId: request.action === "reply.update.reserve" ? request.requestId : child?.proposal.requestId,
            expectedRevision: request.action === "reply.update.reserve" ? request.expectedRevision : child?.proposal.attemptRevision });
          else plan = buildGraphReplyDraft({ ...context,
            requestId: request.action === "reply.reserve" ? request.requestId : original?.plan.requestId,
            mode: request.action === "reply.reserve" ? request.mode : original?.plan.mode });
        }
        if (["reply.update.inspected", "reply.update.review"].includes(request.action)) {
          require([...updates.values()].filter(u => u.sourceId === request.sourceId && u.status !== "cancelled").at(-1)?.id === request.updateId);
          const data = this.version(row.account_id, request.sourceId, prior.revision), draft = drafts.get(key);
          const configured = this.db.prepare("SELECT request_json,auth_epoch FROM private_email_commands WHERE account_id=? AND json_extract(request_json,'$.action')='connection.configure' AND json_extract(receipt_json,'$.connectionId')=? AND json_extract(receipt_json,'$.revision')=?")
            .get(row.account_id, data.envelope?.connection.id ?? "", request.connectionRevision ?? child?.inspection?.connectionRevision ?? -1);
          require(configured && configured.auth_epoch === row.auth_epoch);
          const context = { auth: { account: { id: row.account_id, authEpoch: row.auth_epoch } },
            source: { id: request.sourceId, revision: prior.revision, ...data },
            draft: draft ? { revision: draft.revision, sourceRevision: draft.source_revision, body: draft.body } : null,
            connection: { profile: JSON.parse(configured.request_json).profile, mode: "fixture", state: "active", authEpoch: row.auth_epoch },
            attempt: original, update: child };
          if (request.action === "reply.update.inspected") inspection = buildUpdateInspection(context);
          else review = buildUpdateReview(context);
        }
        if (isReplyUpdate(request)) {
          expected.update = transitionReplyUpdate(updates, request, { proposal, inspection, review,
            dispatch: dispatches.get(canonical([row.account_id, request.dispatchRequestId])), at: row.at });
          updates.set(expected.update.id, expected.update);
          if (request.action === "reply.update.dispatch") dispatches.set(canonical([row.account_id, request.requestId]), expected);
        } else {
          require(request.action !== "reply.review" || ![...updates.values()].some(u => u.attemptId === request.attemptId && u.status !== "cancelled"));
          expected.attempt = transitionReplyAttempt(attempts, request, { plan, authEpoch: row.auth_epoch, at: row.at });
          attempts.set(expected.attempt.id, expected.attempt);
        }
        if (["reply.observed", "reply.update.observed", "reply.update.inspected"].includes(request.action)) replyReads.set(readKey, request.observation);
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
        // Import-guard replay (tasks 32/34): the spam flag is a pure function
        // of the envelope, and the notify decision is recomputed from the
        // journaled prefs snapshot — the owner's live prefs may have changed
        // since the import, so the snapshot (never this.notifyPrefs) is the
        // decision's input. Receipts journaled before the guards existed skip
        // the replay, like the additive read-marker table.
        if (request.action === "source.import" && receipt.notify !== undefined) {
          expected.spam = scoreImportedEnvelope(request.data.envelope);
          expected.notify = replayImportedNotification({ snapshot: receipt.notify.prefs, accountId: row.account_id,
            connectionId: receipt.notify.connectionId, urgent: receipt.notify.urgent, at: receipt.notify.at });
        }
        // Shadow-decision replay: recompute from the journaled flag inputs and
        // the journaled at, exactly as the import path did. Receipts journaled
        // before shadow instrumentation existed skip the replay.
        if (request.action === "source.import" && receipt.shadowQuarantine !== undefined) {
          expected.shadowQuarantine = shadowDecisionForImport({ flag: scoreImportedEnvelope(request.data.envelope),
            envelope: request.data.envelope, at: receipt.shadowQuarantine.at });
        }
        sources.set(key, { account_id: row.account_id, id: request.sourceId, revision: expected.revision, created_at: prior?.created_at ?? row.at, updated_at: row.at }); versions++;
      } else if (["source.read", "source.unread"].includes(request.action)) {
        require(prior?.revision === request.expectedRevision);
        Object.assign(expected, { sourceRevision: request.expectedRevision, readAt: request.action === "source.read" ? row.at : null });
        const marker = canonical([row.account_id, request.sourceId]);
        if (request.action === "source.read") reads.set(marker, { account_id: row.account_id, source_id: request.sourceId, read_at: row.at });
        else reads.delete(marker);
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
    if (readsSchema !== undefined) require(same(rows("private_inbox_reads"), [...reads.values()].map(canonical).sort()));
    return { sources: sources.size, drafts: drafts.size, versions };
    });
  }
}
