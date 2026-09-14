// Fixture qualification driver. Real providers require a separately reviewed
// adapter, credentials, capabilities and external-send authority.
import { createHash } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { previewProvider } from "./inbox-outbox.mjs";

const operation = (kind, value) => kind + "-" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class SyntheticInboxTransport {
  constructor(inbox, adapter) {
    if (typeof adapter?.kind !== "string" || !adapter.kind || typeof adapter.submit !== "function" || typeof adapter.lookup !== "function")
      throw new TypeError("A submit/lookup adapter with a provider kind is required");
    this.inbox = inbox; this.adapter = adapter;
  }
  current(token, sourceId, sendId, binding) {
    const view = this.inbox.sends(token, sourceId, binding), send = view.sends.find(s => s.id === sendId);
    if (!send) throw new ServiceError(404, "inbox_send_not_found", "Reply attempt not found.");
    // An attempt only ever reaches the transport for its own provider.
    if (previewProvider(send.envelope) !== this.adapter.kind) throw new ServiceError(409, "inbox_transport_mismatch", "This reply belongs to a different provider.");
    return send;
  }
  correlation(send) { return operation("reply", [send.envelope.accountId, send.id, send.envelope.previewVersion]); }
  async dispatch(token, sourceId, sendId, binding) {
    const send = this.current(token, sourceId, sendId, binding);
    if (send.status !== "queued") return send;
    const started = this.inbox.transport(token, { action: "send.dispatch", requestId: operation("dispatch", [sendId, send.revision]),
      sourceId, sendId, expectedRevision: send.revision }, binding);
    if (started.duplicate) return this.current(token, sourceId, sendId, binding);
    let observed;
    try { observed = await this.adapter.submit({ operationId: this.correlation(send), envelope: structuredClone(send.envelope) }); }
    catch { return this.current(token, sourceId, sendId, binding); }
    return this.observe(token, started.receipt.send, observed, binding);
  }
  async reconcile(token, sourceId, sendId, binding) {
    const send = this.current(token, sourceId, sendId, binding);
    if (!["unknown", "accepted"].includes(send.status)) return send;
    let observed;
    try { observed = await this.adapter.lookup({ operationId: this.correlation(send), previewVersion: send.envelope.previewVersion }); }
    catch { return this.current(token, sourceId, sendId, binding); }
    return this.observe(token, send, observed, binding);
  }
  observe(token, send, observed, binding) {
    // Missing, uncorrelated and unsupported evidence leaves the attempt unknown;
    // "not found" cannot establish that another request was never accepted.
    if (!observed || observed.operationId !== this.correlation(send) || observed.previewVersion !== send.envelope.previewVersion
      || !["accepted", "delivered", "rejected", "bounced"].includes(observed.outcome))
      return this.current(token, send.sourceId, send.id, binding);
    if (send.status === observed.outcome && send.providerId === observed.providerId)
      return this.current(token, send.sourceId, send.id, binding);
    const request = { action: "send.observe", requestId: operation("observation", [send.id, send.revision, observed]),
      sourceId: send.sourceId, sendId: send.id, expectedRevision: send.revision, outcome: observed.outcome, providerId: observed.providerId };
    try { return this.inbox.transport(token, request, binding).receipt.send; }
    catch (error) {
      if (["stale_inbox_send", "conflicting_inbox_observation", "invalid_inbox_send"].includes(error.code))
        return this.current(token, send.sourceId, send.id, binding);
      throw error;
    }
  }
}

// Inert stand-in for a channel provider whose live bindings are not set. It
// records what would have been sent and answers "accepted" so the reply
// journey can be exercised end to end; nothing leaves the process and the
// browser labels every outcome a sample. `mode = "rejected"` rehearses a
// definitive provider refusal.
export class FixtureChannelSender {
  #sent = new Map(); #status; #scope; #now;
  mode = "accepted";
  constructor({ kind, status = null, accountId = null, connectionId = null, now = () => Date.now() }) {
    if (typeof kind !== "string" || !kind) throw new TypeError("A provider kind is required");
    this.kind = kind; this.#status = status; this.#scope = { accountId, connectionId }; this.#now = now;
  }
  async submit({ operationId, envelope }) {
    const prior = this.#sent.get(operationId);
    if (prior && prior.previewVersion !== envelope.previewVersion) throw new ServiceError(409, "conflicting_inbox_observation", "This operation key already recorded a different reply.");
    if (!prior) {
      const outcome = this.mode === "rejected" ? "rejected" : "accepted";
      this.#sent.set(operationId, { operationId, previewVersion: envelope.previewVersion, outcome, providerId: outcome === "accepted" ? "fixture:" + operationId : null,
        ...(outcome === "rejected" ? { code: "fixture_rejected" } : {}) });
      this.#status?.sent(this.#scope.accountId, this.#scope.connectionId, { at: this.#now(), outcome, code: "fixture" });
    }
    return structuredClone(this.#sent.get(operationId));
  }
  async lookup({ operationId }) { const receipt = this.#sent.get(operationId); return receipt ? structuredClone(receipt) : null; }
  get submits() { return this.#sent.size; }
}
