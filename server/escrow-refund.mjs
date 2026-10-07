// Escrow cancellation/refund path hardening (200-hard-tasks #13).
// Pure refund-policy engine: who can cancel, in which time windows, with
// what pro-rata split on partial completion, and griefing resistance.
// All amount math in BigInt on raw units — no floats. No I/O.
export const DEFAULT_ACCEPT_WINDOW_SEC = 3600; // provider must accept within 1h
export const DEFAULT_NO_SHOW_GRACE_SEC = 7200; // ...or the payer can no-show-cancel

export class RefundPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function createRefundPolicy({ acceptWindowSec = DEFAULT_ACCEPT_WINDOW_SEC } = {}) {
  if (!(acceptWindowSec > 0)) throw new RefundPolicyError("INVALID", "acceptWindowSec must be > 0");

  // progressBps: completed basis points (0..10000) with evidence, or null if unknown.
  // Returns { allowed, code, refundRaw, providerRaw, note } — strings in raw units.
  function assess({ status, amountRaw, fundedAtMs, acceptedAtMs = null, progressBps = null, actor, nowMs = Date.now() }) {
    if (!["funded", "accepted"].includes(status)) {
      throw new RefundPolicyError("CANCEL_AFTER_FINAL", `cannot cancel from ${status}: funds already moved`, { status });
    }
    const amount = BigInt(amountRaw);
    if (amount <= 0n) throw new RefundPolicyError("INVALID", "amountRaw must be > 0");
    if (actor !== "payer" && actor !== "provider") throw new RefundPolicyError("INVALID", "actor must be payer|provider");

    // Provider no-show: funded but never accepted past the window -> payer gets everything.
    if (status === "funded" && nowMs - fundedAtMs > acceptWindowSec * 1000) {
      if (actor !== "payer") throw new RefundPolicyError("NOT_ALLOWED", "only the payer can no-show-cancel", { actor });
      return decision("NO_SHOW", amount, 0n, "provider never accepted within the window; full refund");
    }

    // Cancel before accept: free and correct — full refund, no penalty, no fee.
    if (status === "funded") {
      return decision("CANCEL_PRE_ACCEPT", amount, 0n, "cancelled before acceptance; full refund, no penalty");
    }

    // Accepted: provider defaulting -> full refund, provider forfeits.
    if (actor === "provider") {
      return decision("PROVIDER_DEFAULT", amount, 0n, "provider cancelled after accepting; full refund to payer");
    }

    // Accepted, payer cancels: pro-rata on evidenced progress.
    if (progressBps === null || progressBps === undefined) {
      // No progress evidence: fail closed toward the provider — treat as 0%
      // complete would let a payer steal work; treat as unprovable and refund
      // nothing without evidence? No — the honest fail-closed is full refund
      // ONLY with provider agreement. Without evidence, cancel is rejected:
      // use the dispute path (task #18) instead.
      throw new RefundPolicyError("PROGRESS_EVIDENCE_REQUIRED",
        "payer cancel after accept requires evidenced progressBps (0..10000); use dispute otherwise", {});
    }
    if (!Number.isInteger(progressBps) || progressBps < 0 || progressBps > 10000) {
      throw new RefundPolicyError("INVALID", "progressBps must be an integer 0..10000");
    }
    const providerShare = (amount * BigInt(progressBps)) / 10000n;
    const refundShare = amount - providerShare;
    return decision(
      "PARTIAL_REFUND",
      refundShare,
      providerShare,
      `payer cancelled at ${progressBps / 100}% evidenced completion; pro-rata split`
    );
  }

  function decision(code, refundRaw, providerRaw, note) {
    return { allowed: true, code, refundRaw: refundRaw.toString(), providerRaw: providerRaw.toString(), note };
  }

  // Griefing ledger: tracks pre-accept cancels per payer (visibility, not
  // punishment — pre-accept cancellation stays free). Pure in-memory.
  function createGriefLedger({ windowMs = 24 * 3600 * 1000, strikeAt = 5 } = {}) {
    const cancels = new Map(); // payer -> [timestamps]
    function record(payer, nowMs = Date.now()) {
      const list = (cancels.get(payer) || []).filter((t) => nowMs - t < windowMs);
      list.push(nowMs);
      cancels.set(payer, list);
      return { streak: list.length, flagged: list.length >= strikeAt };
    }
    function streak(payer, nowMs = Date.now()) {
      return (cancels.get(payer) || []).filter((t) => nowMs - t < windowMs).length;
    }
    return { record, streak };
  }

  return { assess, createGriefLedger, acceptWindowSec };
}
