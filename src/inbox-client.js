// Private reads never travel through the room/agent transport.
const fail = (code, message) => Object.assign(new Error(message), { code });
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const boundedText = (value, max) => typeof value === "string" && value.isWellFormed() && value.length <= max;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validReplyReview(value, sourceId, view = "reply-review-v1") {
  if (value.view !== view || value.sourceId !== sourceId) return false;
  if (view === "reply-review-v2" && (value.attempt === null ? value.comparison !== null
    : !boundedText(value.comparison?.originalBody, 4000) || ![null, "reserved", "update_unconfirmed"].includes(value.comparison?.updateStatus)
      || Object.keys(value.comparison).some(k => !["originalBody", "updateStatus"].includes(k)))) return false;
  const a = value.attempt; if (a === null) return true;
  if (!id(a?.id) || !revision(a.revision) || ![a.sourceRevision, a.draftRevision].every(n => revision(n) && n > 0)
    || a.canSend !== false || typeof a.canReview !== "boolean"
    || !["reserved", "creation_unconfirmed", "created_unverified", "awaiting_review", "draft_unavailable", "draft_reviewed"].includes(a.status)) return false;
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
  return (!a.canReview || supported) && (!r?.current || a.canReview) && (a.status !== "draft_reviewed" || r !== null)
    && (view !== "reply-review-v2" || value.comparison.updateStatus === null || !a.canReview && !r?.current);
}
function validSource(source, sourceId, accountId) {
  if (source?.id !== sourceId || !revision(source.revision) || !source.revision) return false;
  if (source.adapter === "synthetic") return ["sender", "recipient", "subject"].every(k => boundedText(source[k], 240))
    && Array.isArray(source.paragraphs) && source.paragraphs.length <= 20 && source.paragraphs.every(p => boundedText(p, 4000));
  const e = source.email, c = source.capabilities;
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
  if (!p || p.adapter !== "synthetic" || p.accountId !== accountId || p.sourceId !== sourceId
    || !revision(p.authEpoch) || ![p.sourceRevision, p.draftRevision].every(n => revision(n) && n > 0)
    || ![p.from, p.subject].every(v => typeof v === "string" && v.length <= 240)
    || !Array.isArray(p.to) || p.to.length !== 1 || typeof p.to[0] !== "string" || p.to[0].length > 240
    || typeof p.body !== "string" || !p.body.trim() || p.body.length > 4000 || !Array.isArray(p.attachments) || p.attachments.length) return false;
  const envelope = { adapter: p.adapter, accountId: p.accountId, authEpoch: p.authEpoch, sourceId: p.sourceId,
    sourceRevision: p.sourceRevision, draftRevision: p.draftRevision, from: p.from, to: p.to, subject: p.subject, body: p.body, attachments: p.attachments };
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
  if (v.sourceId !== sourceId || typeof v.simulationAvailable !== "boolean" || !Array.isArray(v.sends)) return false;
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
  list() { return this.request("?view=email-excerpt-v1", {}, v => Array.isArray(v.sources) && v.sources.every(s => id(s.id) && revision(s.revision) && s.revision > 0 && typeof s.subject === "string")); }
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
      && typeof v.simulationAvailable === "boolean" && v.preview?.authEpoch === v.viewer.authEpoch
      && await validEnvelope(v.preview, v.viewer.accountId, sourceId));
  }
  sends(sourceId) { return this.request("/sources/" + encodeURIComponent(sourceId) + "/sends", {}, v => validSends(v, sourceId)); }
  replyReview(sourceId) {
    return this.request("/sources/" + encodeURIComponent(sourceId) + "/reply-review?view=reply-review-v2", {}, v => validReplyReview(v, sourceId, "reply-review-v2"));
  }
  reviewReply(request) {
    const data = structuredClone(request);
    return this.request("/review", { method: "POST", data }, v => {
      const r = v.receipt;
      return data.action === "reply.review" && typeof v.duplicate === "boolean" && r?.action === data.action
        && r.requestId === data.requestId && r.sourceId === data.sourceId && r.attemptId === data.attemptId
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
          : r.revision === data.expectedRevision + 1 && (!data.action.startsWith("draft.") || r.sourceRevision === data.sourceRevision));
    });
  }
}
