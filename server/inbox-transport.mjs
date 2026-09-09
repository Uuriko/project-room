// Synthetic qualification driver. Real providers require a separately reviewed
// adapter, credentials, capabilities and external-send authority.
import { createHash } from "node:crypto";
import { ServiceError } from "./store.mjs";

const operation = (kind, value) => kind + "-" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class SyntheticInboxTransport {
  constructor(inbox, adapter) {
    if (adapter?.kind !== "synthetic" || typeof adapter.submit !== "function" || typeof adapter.lookup !== "function")
      throw new TypeError("A synthetic submit/lookup adapter is required");
    this.inbox = inbox; this.adapter = adapter;
  }
  current(token, sourceId, sendId, binding) {
    const view = this.inbox.sends(token, sourceId, binding), send = view.sends.find(s => s.id === sendId);
    if (!send) throw new ServiceError(404, "inbox_send_not_found", "Reply attempt not found.");
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
