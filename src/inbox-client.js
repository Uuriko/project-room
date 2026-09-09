// Private reads never travel through the room/agent transport.
const fail = (code, message) => Object.assign(new Error(message), { code });
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
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
      if (!validate(value)) throw fail("invalid_inbox_response", "Inbox response could not be confirmed.");
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
  apply(request) {
    // Capture exact bytes before awaiting. The caller retains this request for an
    // uncertain retry instead of generating another operation.
    const data = structuredClone(request);
    return this.request("/commands", { method: "POST", data }, v => {
      const r = v.receipt;
      return typeof v.duplicate === "boolean" && r?.requestId === data.requestId && r.action === data.action && r.sourceId === data.sourceId
        && (data.action === "source.share" ? r.roomId === data.roomId && r.sourceRevision === data.sourceRevision && id(r.messageId) && id(r.eventId) && revision(r.sequence)
          : r.revision === data.expectedRevision + 1 && (data.action !== "draft.save" || r.sourceRevision === data.sourceRevision));
    });
  }
}
