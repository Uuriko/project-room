// Shared settlement adapter interface (200-hard-tasks #6/#7/#15).
// In-memory local-only adapter every chain leg (Monad mock, Solana mock,
// future EVM legs) must implement. Lifecycle: fund -> accept -> release,
// or fund -> refund / fund -> accept -> cancel -> refund.
// Duplicate events and illegal transitions are rejected, not silently applied.
import { assertEnvelope, toRaw } from "./settlement-envelope.mjs";

export const TRANSITIONS = Object.freeze({
  draft: ["funded"],
  funded: ["accepted", "refunded", "cancelled"],
  accepted: ["released", "cancelled", "disputed"],
  disputed: ["released", "refunded"],
  released: [],
  refunded: [],
  cancelled: ["refunded"],
});

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Base class: chain legs extend and pass their chain id + canonical asset.
export class SettlementAdapter {
  constructor({ name, chainId, assetMint, assetDecimals }) {
    if (!name || !chainId || !assetMint || !Number.isInteger(assetDecimals)) {
      throw new Error("SettlementAdapter: name, chainId, assetMint, assetDecimals required");
    }
    this.name = name;
    this.chainId = chainId;
    this.assetMint = assetMint;
    this.assetDecimals = assetDecimals;
    this._escrows = new Map(); // envelope id -> record
    this._events = []; // append-only event log { seq, type, id, at, data }
    this._seq = 0;
  }

  get expectations() {
    return { chainId: this.chainId, assetMint: this.assetMint };
  }

  _emit(type, id, data = {}) {
    const event = { seq: ++this._seq, type, id, at: new Date().toISOString(), data };
    this._events.push(Object.freeze(event));
    return event;
  }

  events() {
    return this._events.slice();
  }

  get(id) {
    const rec = this._escrows.get(id);
    return rec ? { ...rec } : null;
  }

  _transition(id, to, data = {}) {
    const rec = this._escrows.get(id);
    if (!rec) throw new AdapterError("ADAPTER_UNKNOWN_ID", `${this.name}: unknown escrow ${id}`);
    const allowed = TRANSITIONS[rec.status] || [];
    if (!allowed.includes(to)) {
      throw new AdapterError(
        "ADAPTER_ILLEGAL_TRANSITION",
        `${this.name}: cannot move ${rec.status} -> ${to}`,
        { from: rec.status, to }
      );
    }
    rec.status = to;
    rec.updatedAtIso = new Date().toISOString();
    this._emit(to, id, data);
    return { ...rec };
  }

  fund(envelope, expectedAmountRaw = null) {
    const expectations = { ...this.expectations };
    if (expectedAmountRaw != null) expectations.amountRaw = String(expectedAmountRaw);
    assertEnvelope(envelope, expectations);
    const expectedAmount = envelope.chain.amountRaw;
    if (!/^\d+$/.test(String(expectedAmount))) {
      throw new AdapterError("ADAPTER_WRONG_AMOUNT", `${this.name}: amountRaw not an integer string`);
    }
    if (this._escrows.has(envelope.id)) {
      // Duplicate fund event: replay protection — return existing, do not double-book.
      this._emit("fund.duplicate", envelope.id, {});
      return { ...this._escrows.get(envelope.id), duplicate: true };
    }
    const rec = {
      id: envelope.id,
      jobId: envelope.jobId,
      payer: envelope.payer,
      payee: envelope.payee,
      amountRaw: expectedAmount,
      status: "funded",
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    this._escrows.set(envelope.id, rec);
    this._emit("funded", envelope.id, { amountRaw: expectedAmount });
    return { ...rec };
  }

  accept(id) {
    return this._transition(id, "accepted");
  }

  release(id, receipt) {
    if (!receipt || typeof receipt !== "object") {
      throw new AdapterError("ADAPTER_RECEIPT_REQUIRED", `${this.name}: release requires receipt evidence`);
    }
    return this._transition(id, "released", { receipt });
  }

  refund(id, reason = "unspecified") {
    const rec = this.get(id);
    if (!rec) throw new AdapterError("ADAPTER_UNKNOWN_ID", `${this.name}: unknown escrow ${id}`);
    if (rec.status === "accepted" || rec.status === "funded") {
      // Direct refund from funded: go via cancelled for an honest audit trail.
      this._transition(id, "cancelled", { reason });
    }
    return this._transition(id, "refunded", { reason });
  }

  cancel(id, reason = "unspecified") {
    return this._transition(id, "cancelled", { reason });
  }

  dispute(id, evidence) {
    return this._transition(id, "disputed", { evidence });
  }

  toRaw(displayAmount) {
    return toRaw(displayAmount, this.assetDecimals);
  }
}
