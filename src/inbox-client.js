// Private reads never travel through the room/agent transport.
const fail = (code, message) => Object.assign(new Error(message), { code });
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const boundedText = (value, max) => typeof value === "string" && value.isWellFormed() && value.length <= max;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validReplyReview(value, sourceId, view = "reply-review-v1") {
  if (value.view !== view || value.sourceId !== sourceId) return false;
  if (view !== "reply-review-v1" && (value.attempt === null ? value.comparison !== null
    : !boundedText(value.comparison?.originalBody, 4000) || ![null, "reserved", "update_unconfirmed",
      ...(["reply-review-v3", "reply-review-v4"].includes(view) ? ["update_acknowledged"] : []),
      ...(view === "reply-review-v4" ? ["resolved"] : [])].includes(value.comparison?.updateStatus)
      || Object.keys(value.comparison).some(k => !["originalBody", "updateStatus"].includes(k)))) return false;
  const a = value.attempt;
  if (a !== null && !validReplyTarget(a)) return false;
  if (view === "reply-review-v4") {
    const u = value.update;
    if (u === null) return a === null || value.comparison.updateStatus === null;
    return a !== null && validReplyTarget(u, true) && u.attemptId === a.id && u.status === value.comparison.updateStatus
      && !a.canReview && !a.review?.current;
  }
  return a === null || view === "reply-review-v1" || value.comparison.updateStatus === null || !a.canReview && !a.review?.current;
}
function validReplyTarget(a, update = false) {
  if (!id(a?.id) || !revision(a.revision) || ![a.sourceRevision, a.draftRevision].every(n => revision(n) && n > 0)
    || a.canSend !== false || typeof a.canReview !== "boolean"
    || !(update ? ["reserved", "update_unconfirmed", "update_acknowledged", "resolved"]
      : ["reserved", "creation_unconfirmed", "created_unverified", "awaiting_review", "draft_unavailable", "draft_reviewed"]).includes(a.status)
    || update && (!id(a.attemptId) || typeof a.versionMismatch !== "boolean"
      || a.canReview && !["update_acknowledged", "resolved"].includes(a.status))) return false;
  const o = a.observation, r = a.review;
  if (o !== null && (!hash(o?.version) || ![o.from, o.sender].every(v => boundedText(v, 320)) || !boundedText(o.subject, 4096)
    || !["text", "html"].includes(o.format) || (o.format === "text" ? !boundedText(o.body, 32768) : o.body !== null)
    || !["to", "cc", "bcc"].every(k => Array.isArray(o[k]) && o[k].length <= 200 && o[k].every(v => boundedText(v, 320)))
    || o.to.length + o.cc.length + o.bcc.length > 200 || !revision(o.attachmentCount) || o.attachmentCount > 100
    || !["complete", "partial", "not_loaded"].includes(o.attachmentState) || !Array.isArray(o.differences)
    || o.differences.some(v => !["draft_state", "thread", "from", "sender", "to", "cc", "bcc", "subject", "body", "attachments"].includes(v)))) return false;
  if (r !== null && (!hash(r?.version) || !revision(r.at) || typeof r.current !== "boolean" || r.version !== o?.version)) return false;
  const supported = o?.format === "text" && o.attachmentState === "complete" && o.attachmentCount === 0
    && o.to.length + o.cc.length + o.bcc.length > 0 && !o.differences.some(v => ["draft_state", "thread", "from", "sender", "attachments"].includes(v));
  return (!a.canReview || supported) && (!r?.current || a.canReview) && (a.status !== "draft_reviewed" || r !== null);
}
const connectionStates = ["active", "disconnected", "reconnect_required"], channels = { email: "Email", telegram: "Telegram" };
const validConnectionRef = c => c === null || (id(c?.id) && Object.hasOwn(channels, c.channel) && boundedText(c.provider, 64)
  && connectionStates.includes(c.state) && Object.keys(c).length === 4);
const isoTime = v => v === null || (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)));
const liveStates = ["not_configured", "invalid", "configured"], webhookStates = ["unset", "set", "matches", "differs"];
// Live status carries binding names and states only; a value or hash in it is a contract violation.
export const validLive = live => live === null || (live?.contractVersion === 1 && live.channel === "telegram" && liveStates.includes(live.state)
  && [live.bindings, live.missing, live.invalid].every(list => Array.isArray(list) && list.length <= 8 && list.every(n => /^[A-Z][A-Z0-9_]{1,63}$/.test(n)))
  && webhookStates.includes(live.webhook) && isoTime(live.webhookSetAt) && isoTime(live.lastUpdateReceivedAt) && revision(live.receivedUpdates)
  && (live.lastSendResult === null || (isoTime(live.lastSendResult.at) && ["accepted", "rejected", "failed"].includes(live.lastSendResult.outcome)
    && (live.lastSendResult.code === null || boundedText(live.lastSendResult.code, 64))))
  && typeof live.importAvailable === "boolean");
export const validConnectionRecord = (v, connectionId) => v.connection?.id === connectionId && validConnection(v.connection, v.viewer.accountId)
  && v.mode === "fixture" && typeof v.webhook === "boolean" && isoTime(v.webhookSetAt ?? null) && typeof v.syncAvailable === "boolean" && validLive(v.live ?? null);
const validSendResult = r => r === null || (isoTime(r?.at) && ["accepted", "rejected", "failed"].includes(r.outcome) && (r.code === null || boundedText(r.code, 64)));
// Which transport, if any, this deployment replies through for a channel source: the live
// provider or the inert fixture. Email has none until an outbound email slice exists.
const channelSendProviders = ["telegram-bot"];
export const validChannelSend = c => c === null || (channelSendProviders.includes(c?.provider) && ["fixture", "live"].includes(c.mode) && Object.keys(c).length === 2);
// The owner's connection commands: add or update a profile, or disconnect. Nothing else travels here.
export function validConnectionCommand(r) {
  if (!r || typeof r !== "object" || !id(r.requestId) || !id(r.connectionId) || !revision(r.expectedRevision)) return false;
  if (r.action === "connection.disconnect") return Object.keys(r).length === 4;
  if (r.action !== "connection.configure" || Object.keys(r).length !== 5) return false;
  const p = r.profile;
  return p?.id === r.connectionId && p.revision === r.expectedRevision + 1 && (Object.hasOwn(p, "mailboxId")
    ? p.provider === "microsoft-graph" && boundedText(p.mailboxId, 2048) && boundedText(p.identity?.name, 1024) && boundedText(p.identity?.address, 320) && Array.isArray(p.aliases)
    : validConnection({ ...p, state: "active" }, p.accountId));
}
export function validConnection(c, accountId) {
  return c?.accountId === accountId && id(c.id) && revision(c.revision) && c.revision > 0 && Object.hasOwn(channels, c.channel)
    && boundedText(c.provider, 64) && boundedText(c.externalId, 2048) && connectionStates.includes(c.state)
    && ["kind", "id", "handle", "displayName"].every(k => boundedText(c.identity?.[k], 2048)) && Object.keys(c.identity).length === 4
    && ["read", "send", "threads", "edit"].every(k => typeof c.capabilities?.[k] === "boolean") && Object.keys(c.capabilities).length === 4
    && Object.keys(c).length === 9;
}
function validSource(source, sourceId, accountId) {
  if (source?.id !== sourceId || !revision(source.revision) || !source.revision) return false;
  if (source.adapter === "synthetic") return ["sender", "recipient", "subject"].every(k => boundedText(source[k], 240))
    && Array.isArray(source.paragraphs) && source.paragraphs.length <= 20 && source.paragraphs.every(p => boundedText(p, 4000));
  const e = source.email, c = source.capabilities;
  if (typeof source.needsYou !== "boolean") return false;
  if (source.adapter === "telegram") {
    const ch = source.channel;
    // `send` may be true on an active bot connection; the deployment's transport is negotiated separately.
    return ch?.view === "channel-excerpt-v1" && ch.accountId === accountId && ch.channel === "telegram" && boundedText(ch.provider, 64)
      && connectionStates.includes(ch.connectionState) && ch.format === "text" && ["message", "edited_message", "channel_post"].includes(ch.kind)
      && typeof ch.edited === "boolean" && boundedText(ch.chat, 2048) && revision(ch.attachmentCount) && ch.attachmentCount <= 20
      && ["sender", "recipient", "subject"].every(k => boundedText(source[k], 2048)) && c?.draft === true && typeof c.send === "boolean"
      && (!c.send || ch.connectionState === "active")
      && Array.isArray(source.paragraphs) && source.paragraphs.length === 1 && boundedText(source.paragraphs[0], 16384) && !source.paragraphs[0].includes("\r")
      && c.share === Boolean(source.paragraphs[0].trim());
  }
  return source.adapter === "email" && e?.view === "email-excerpt-v1" && e.accountId === accountId
    && ["text", "html"].includes(e.format) && ["active", "disconnected", "reconnect_required"].includes(e.connectionState)
    && ["sender", "recipient"].every(k => boundedText(source[k], 320)) && boundedText(source.subject, 4096)
    && c?.draft === true && c.send === false
    && ["to", "cc", "bcc"].every(k => Array.isArray(e[k]) && e[k].length <= 200 && e[k].every(a => boundedText(a, 320)))
    && e.to.length + e.cc.length + e.bcc.length <= 200
    && ["not_loaded", "partial", "complete"].includes(e.attachmentState) && revision(e.attachmentCount) && e.attachmentCount <= 100
    && Array.isArray(source.paragraphs) && (e.format === "html" ? source.paragraphs.length === 0
      : source.paragraphs.length === 1 && boundedText(source.paragraphs[0], 262144) && !source.paragraphs[0].includes("\r"))
    && c.share === (e.format === "text" && Boolean(source.paragraphs[0].trim()));
}
const canonical = value => value && typeof value === "object"
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
export const inboxTextVersion = async body => "sha256:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map(n => n.toString(16).padStart(2, "0")).join("");
async function validResult(proof, body, version, sourceRevision, roomId, workItemId) {
  return proof?.roomId === roomId && proof.workItemId === workItemId && proof.sourceRevision === sourceRevision
    && ["shareRequestId", "messageId", "completionEventId", "verificationEventId", "decisionEventId"].every(k => id(proof[k]))
    && revision(proof.workRevision) && typeof body === "string" && body.length <= 4000
    && proof.evidenceVersion === await inboxTextVersion(body)
    && version === (await inboxTextVersion(canonical(proof))).slice(7);
}
async function validEnvelope(p, accountId, sourceId) {
  if (!p || !["synthetic", "telegram"].includes(p.adapter) || p.accountId !== accountId || p.sourceId !== sourceId
    || !revision(p.authEpoch) || ![p.sourceRevision, p.draftRevision].every(n => revision(n) && n > 0)
    || ![p.from, p.subject].every(v => typeof v === "string" && v.length <= 2048)
    || !Array.isArray(p.to) || p.to.length !== 1 || typeof p.to[0] !== "string" || p.to[0].length > 2048
    || typeof p.body !== "string" || !p.body.trim() || p.body.length > 4000 || !Array.isArray(p.attachments) || p.attachments.length) return false;
  const common = { accountId: p.accountId, authEpoch: p.authEpoch, sourceId: p.sourceId, sourceRevision: p.sourceRevision, draftRevision: p.draftRevision };
  let envelope;
  if (p.adapter === "synthetic") {
    if (p.from.length > 240 || p.subject.length > 240 || p.to[0].length > 240) return false;
    envelope = { adapter: p.adapter, ...common, from: p.from, to: p.to, subject: p.subject, body: p.body, attachments: p.attachments };
  } else {
    // Telegram replies name the bot connection and its target chat; field order matches the server preview.
    const t = p.target;
    if (p.provider !== "telegram-bot" || p.subject !== "" || !["chatId", "replyToMessageId", "threadId"].every(k => boundedText(t?.[k], 64)) || Object.keys(t).length !== 3) return false;
    envelope = { adapter: p.adapter, provider: p.provider, ...common, from: p.from, to: p.to, subject: p.subject, body: p.body, attachments: p.attachments, target: t };
  }
  return p.previewVersion === (await inboxTextVersion(JSON.stringify(envelope))).slice(7);
}
async function validSend(send, accountId, sourceId) {
  return id(send?.id) && send.sourceId === sourceId && revision(send.revision)
    && ["queued", "unknown", "accepted", "delivered", "rejected", "bounced", "cancelled"].includes(send.status)
    && (["accepted", "delivered", "bounced"].includes(send.status) ? id(send.providerId) : send.providerId === null)
    && revision(send.createdAt) && revision(send.updatedAt)
    && await validEnvelope(send.envelope, accountId, sourceId);
}
async function validSends(v, sourceId) {
  if (v.sourceId !== sourceId || typeof v.simulationAvailable !== "boolean" || !Array.isArray(v.sends) || !validChannelSend(v.channelSend ?? null)) return false;
  const seen = new Set();
  for (const send of v.sends) {
    if (!send || seen.has(send.id) || !await validSend(send, v.viewer.accountId, sourceId)) return false;
    seen.add(send.id);
  }
  return true;
}
export class InboxClient {
  constructor(account, { onAccessEnded = () => {} } = {}) { this.account = account; this.onAccessEnded = onAccessEnded; this.generation = 0; }
  reset() { this.generation++; }
  owner() {
    const session = this.account.currentSession("opening your inbox", { authenticated: true });
    return { session, accountGeneration: this.account.generation, generation: this.generation };
  }
  owns(owner) { return owner.generation === this.generation && this.account.owns(owner.accountGeneration, owner.session); }
  async request(path, options = {}, validate = () => true) {
    const owner = this.owner();
    try {
      const value = await this.account.request("/api/inbox" + path, { ...options, session: owner.session });
      if (!this.owns(owner)) throw fail("obsolete_inbox", "Account changed.");
      const v = value?.viewer, s = owner.session;
      if (value?.contractVersion !== 1 || v?.accountId !== s.account.id || v.authEpoch !== s.account.authEpoch
        || v.sessionBinding !== s.sessionBinding || v.sessionRevision !== s.sessionRevision) {
        this.reset(); this.onAccessEnded(); throw fail("obsolete_inbox", "Account changed.");
      }
      if (!await validate(value)) throw fail("invalid_inbox_response", "Inbox response could not be confirmed.");
      if (!this.owns(owner)) throw fail("obsolete_inbox", "Account changed.");
      return value;
    } catch (error) {
      if (!this.owns(owner)) throw fail("obsolete_inbox", "Account changed.");
      if (error.status === 401 || ["session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code)) {
        this.reset(); this.onAccessEnded(); throw fail("obsolete_inbox", "Account changed.");
      }
      throw error;
    }
  }
  // One row of the list/search projection, as returned by the server.
  validSourceSummary(s) {
    return s !== null && typeof s === "object" && id(s.id) && revision(s.revision) && s.revision > 0
      && typeof s.subject === "string" && ["synthetic", "email", "telegram"].includes(s.adapter) && validConnectionRef(s.connection ?? null)
      && (s.adapter === "synthetic") === ((s.connection ?? null) === null) && typeof s.needsYou === "boolean" && (!s.needsYou || s.adapter !== "synthetic")
      && ["sender", "recipient"].every(k => typeof s[k] === "string");
  }
  list({ cursor = null, limit = null } = {}) {
    const params = new URLSearchParams({ view: "email-excerpt-v1" });
    if (cursor !== null && cursor !== undefined) params.set("cursor", cursor);
    if (limit !== null && limit !== undefined) params.set("limit", String(limit));
    return this.request(`?${params}`, {}, v => Array.isArray(v.sources) && v.sources.every(s => this.validSourceSummary(s))
      && (v.nextCursor === null || typeof v.nextCursor === "string"));
  }
  // Full-text search over the account's visible sources. Results are
  // { source, score } pairs, best first; total counts all matches.
  threads({ sourceId = null, limit = null } = {}) {
    const params = new URLSearchParams({ view: "email-excerpt-v1" });
    if (sourceId !== null && sourceId !== undefined) params.set("sourceId", sourceId);
    if (limit !== null && limit !== undefined) params.set("limit", String(limit));
    return this.request(`/threads?${params}`, {}, v => Number.isSafeInteger(v.total) && v.total >= 0
      && Array.isArray(v.threads) && v.threads.every(t => typeof t.threadId === "string"
        && Number.isSafeInteger(t.messageCount) && t.messageCount > 0 && Number.isSafeInteger(t.depth) && t.depth >= 0
        && typeof t.firstAt === "string" && typeof t.lastAt === "string"
        && Array.isArray(t.entries) && t.entries.every(e => Number.isSafeInteger(e.depth) && e.depth >= 0 && this.validSourceSummary(e.source))));
  }
  // Attachment descriptors for one source: metadata only, never bytes.
  // The single-attachment call also verifies descriptor membership and
  // carries the retrieval handle a future byte-fetch will use.
  attachments(sourceId) {
    return this.request(`/sources/${encodeURIComponent(sourceId)}/attachments?view=email-excerpt-v1`, {},
      v => v.sourceId === sourceId && Array.isArray(v.attachments)
        && v.attachments.every(a => typeof a.id === "string" && typeof a.kind === "string"
          && (a.name === null || typeof a.name === "string") && (a.contentType === null || typeof a.contentType === "string")
          && (a.size === null || (Number.isSafeInteger(a.size) && a.size >= 0)) && typeof a.inline === "boolean"));
  }
  attachment(sourceId, attachmentId) {
    return this.request(`/sources/${encodeURIComponent(sourceId)}/attachments/${encodeURIComponent(attachmentId)}?view=email-excerpt-v1`, {},
      v => v.sourceId === sourceId && typeof v.attachment?.id === "string" && v.attachment.id === attachmentId
        && v.retrieval?.available === false && typeof v.retrieval?.reason === "string");
  }
  search({ query, sourceId = null, limit = null } = {}) {
    const params = new URLSearchParams({ view: "email-excerpt-v1", q: query });
    if (sourceId !== null && sourceId !== undefined) params.set("sourceId", sourceId);
    if (limit !== null && limit !== undefined) params.set("limit", String(limit));
    return this.request(`/search?${params}`, {}, v => typeof v.query === "string" && Number.isSafeInteger(v.total) && v.total >= 0
      && Array.isArray(v.results) && v.results.every(r => typeof r.score === "number" && r.score > 0 && this.validSourceSummary(r.source)));
  }
  // Owner-managed connection records: add or update a bot/mailbox profile, or disconnect ("Remove").
  applyConnection(request) {
    const data = structuredClone(request);
    if (!validConnectionCommand(data)) return Promise.reject(fail("invalid_channel_connection", "Choose a supported connection command."));
    return this.request("/connections/commands", { method: "POST", data }, v => validConnectionRecord(v, data.connectionId) && typeof v.duplicate === "boolean"
      && v.receipt?.requestId === data.requestId && v.receipt.action === data.action && v.receipt.connectionId === data.connectionId
      && v.receipt.revision === data.expectedRevision + 1 && v.receipt.state === (data.action === "connection.configure" ? "active" : "disconnected"));
  }
  connections() { return this.request("/connections", {}, v => Array.isArray(v.connections) && v.connections.every(c => validConnection(c, v.viewer.accountId))); }
  connection(connectionId) {
    return this.request("/connections/" + encodeURIComponent(connectionId), {}, v => validConnectionRecord(v, connectionId));
  }
  // Owner-authenticated live import trigger (re-registers the webhook secret when
  // the deployment's Telegram bindings are set, then drains verified updates).
  reconnectConnection(connectionId, requestId) {
    return this.request("/connections/" + encodeURIComponent(connectionId) + "/reconnect", { method: "POST", data: { requestId } },
      v => validConnectionRecord(v, connectionId) && typeof v.registered === "boolean" && typeof v.duplicate === "boolean"
        && (v.imported === null || revision(v.imported)) && [null, "webhook", "journal", "recording"].includes(v.source));
  }
  read(sourceId) {
    return this.request("/sources/" + encodeURIComponent(sourceId) + "?view=email-excerpt-v1", {}, v => validSource(v.source, sourceId, v.viewer.accountId)
      && (v.draft === null || revision(v.draft?.revision) && v.draft.revision > 0 && revision(v.draft.sourceRevision)
        && v.draft.sourceRevision > 0 && v.draft.sourceRevision <= v.source.revision && boundedText(v.draft.body, 4000)));
  }
  context(sourceId, roomId) {
    return this.request("/sources/" + encodeURIComponent(sourceId) + "/share-context?roomId=" + encodeURIComponent(roomId), {},
      v => v.sourceId === sourceId && v.roomId === roomId && revision(v.sourceRevision) && v.sourceRevision > 0
        && /^[a-f0-9]{64}$/.test(v.audienceVersion) && typeof v.roomTitle === "string"
        && Array.isArray(v.members) && v.members.every(m => id(m.id) && typeof m.displayName === "string" && ["human", "agent"].includes(m.kind)));
  }
  sendContext(sourceId) {
    return this.request("/sources/" + encodeURIComponent(sourceId) + "/send-context", {}, async v => v.sourceId === sourceId
      && typeof v.simulationAvailable === "boolean" && validChannelSend(v.channelSend ?? null) && v.preview?.authEpoch === v.viewer.authEpoch
      && await validEnvelope(v.preview, v.viewer.accountId, sourceId));
  }
  // Dispatch or reconcile a queued channel reply through the deployment's transport (live or fixture).
  channelSend(action, sourceId, sendId) {
    return this.request("/channel-sends", { method: "POST", data: { action, sourceId, sendId } }, async v =>
      validChannelSend(v.channelSend) && v.channelSend !== null && await validSends(v, sourceId) && v.send?.id === sendId
      && await validSend(v.send, v.viewer.accountId, sourceId) && validSendResult(v.lastSendResult ?? null));
  }
  sends(sourceId) { return this.request("/sources/" + encodeURIComponent(sourceId) + "/sends", {}, v => validSends(v, sourceId)); }
  replyReview(sourceId) {
    return this.request("/sources/" + encodeURIComponent(sourceId) + "/reply-review?view=reply-review-v4", {}, v => validReplyReview(v, sourceId, "reply-review-v4"));
  }
  reviewReply(request) {
    const data = structuredClone(request);
    return this.request("/review", { method: "POST", data }, v => {
      const r = v.receipt;
      return ["reply.review", "reply.update.review"].includes(data.action) && typeof v.duplicate === "boolean" && r?.action === data.action
        && r.requestId === data.requestId && r.sourceId === data.sourceId && r.attemptId === data.attemptId
        && (data.action !== "reply.update.review" || r.updateId === data.updateId)
        && r.revision === data.expectedRevision + 1 && r.reviewVersion === data.reviewVersion;
    });
  }
  simulate(action, sourceId, sendId) {
    return this.request("/simulation", { method: "POST", data: { action, sourceId, sendId } }, async v =>
      v.simulationAvailable === true && await validSends(v, sourceId) && v.send?.id === sendId
      && await validSend(v.send, v.viewer.accountId, sourceId));
  }
  results(sourceId, roomId, workItemId = null) {
    return this.request("/sources/" + encodeURIComponent(sourceId) + "/room-results?roomId=" + encodeURIComponent(roomId)
      + (workItemId === null ? "" : "&workItemId=" + encodeURIComponent(workItemId)), {}, async v => {
        if (v.sourceId !== sourceId || v.roomId !== roomId || !revision(v.sourceRevision) || !Array.isArray(v.results)
          || (workItemId !== null && (v.results.length !== 1 || v.results[0].workItemId !== workItemId))) return false;
        for (const result of v.results) {
          if (!id(result.workItemId) || !id(result.shareRequestId) || !id(result.messageId) || typeof result.title !== "string"
            || !["ready", "source_changed", "superseded", "no_native_result", "needs_review", "too_long"].includes(result.status)) return false;
          if (workItemId !== null && result.status === "ready" && !await validResult(result.proof, result.body, result.resultVersion, v.sourceRevision, roomId, workItemId)) return false;
        }
        return true;
      });
  }
  apply(request) {
    // Capture exact bytes before awaiting. The caller retains this request for an
    // uncertain retry instead of generating another operation.
    const data = structuredClone(request);
    return this.request("/commands", { method: "POST", data }, async v => {
      const r = v.receipt;
      if (data.action.startsWith("send.")) {
        if (!["send.reserve", "send.cancel"].includes(data.action) || typeof v.duplicate !== "boolean"
          || r?.requestId !== data.requestId || r.action !== data.action || r.sourceId !== data.sourceId
          || !await validSend(r.send, v.viewer.accountId, data.sourceId)) return false;
        return data.action === "send.reserve" ? r.send.id === data.requestId && r.send.revision === 0 && r.send.status === "queued"
          && r.send.envelope.previewVersion === data.previewVersion && r.send.envelope.sourceRevision === data.sourceRevision
          && r.send.envelope.draftRevision === data.draftRevision
          : r.send.id === data.sendId && r.send.revision === data.expectedRevision + 1 && r.send.status === "cancelled";
      }
      if (data.action === "draft.adopt") {
        const { roomSequence, ...proof } = r?.origin ?? {};
        if (!revision(roomSequence) || !await validResult(proof, r?.body, data.resultVersion, data.sourceRevision, data.roomId, data.workItemId)
          || proof.shareRequestId !== data.shareRequestId) return false;
      }
      return typeof v.duplicate === "boolean" && r?.requestId === data.requestId && r.action === data.action && r.sourceId === data.sourceId
        && (["source.share", "source.excerpt"].includes(data.action) ? r.roomId === data.roomId && r.sourceRevision === data.sourceRevision && id(r.messageId) && id(r.eventId) && revision(r.sequence)
          : ["source.read", "source.unread"].includes(data.action) ? r.sourceRevision === data.expectedRevision
            && (data.action === "source.unread" ? r.readAt === null : Number.isSafeInteger(r.readAt) && r.readAt > 0)
          : r.revision === data.expectedRevision + 1 && (!data.action.startsWith("draft.") || r.sourceRevision === data.sourceRevision));
    });
  }
}
