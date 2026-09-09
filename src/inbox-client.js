// Private reads never travel through the room/agent transport.
const fail = (code, message) => Object.assign(new Error(message), { code });
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
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
  list() { return this.request("", {}, v => Array.isArray(v.sources) && v.sources.every(s => id(s.id) && revision(s.revision) && s.revision > 0 && typeof s.subject === "string")); }
  read(sourceId) {
    return this.request("/sources/" + encodeURIComponent(sourceId), {}, v => v.source?.id === sourceId
      && revision(v.source.revision) && v.source.revision > 0 && v.source.adapter === "synthetic"
      && ["sender", "recipient", "subject"].every(k => typeof v.source[k] === "string")
      && Array.isArray(v.source.paragraphs) && v.source.paragraphs.every(p => typeof p === "string")
      && (v.draft === null || revision(v.draft?.revision) && v.draft.revision > 0 && revision(v.draft.sourceRevision) && typeof v.draft.body === "string"));
  }
  context(sourceId, roomId) {
    return this.request("/sources/" + encodeURIComponent(sourceId) + "/share-context?roomId=" + encodeURIComponent(roomId), {},
      v => v.sourceId === sourceId && v.roomId === roomId && revision(v.sourceRevision) && v.sourceRevision > 0
        && /^[a-f0-9]{64}$/.test(v.audienceVersion) && typeof v.roomTitle === "string"
        && Array.isArray(v.members) && v.members.every(m => id(m.id) && typeof m.displayName === "string" && ["human", "agent"].includes(m.kind)));
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
      if (data.action === "draft.adopt") {
        const { roomSequence, ...proof } = r?.origin ?? {};
        if (!revision(roomSequence) || !await validResult(proof, r?.body, data.resultVersion, data.sourceRevision, data.roomId, data.workItemId)
          || proof.shareRequestId !== data.shareRequestId) return false;
      }
      return typeof v.duplicate === "boolean" && r?.requestId === data.requestId && r.action === data.action && r.sourceId === data.sourceId
        && (data.action === "source.share" ? r.roomId === data.roomId && r.sourceRevision === data.sourceRevision && id(r.messageId) && id(r.eventId) && revision(r.sequence)
          : r.revision === data.expectedRevision + 1 && (!data.action.startsWith("draft.") || r.sourceRevision === data.sourceRevision));
    });
  }
}
