// Job/payment state machine tests (200-hard-tasks #5).
// Contract guarded: job acceptance and payment finality are separate
// dimensions with explicit cross-rules — settle requires (completed, funded)
// plus receipt evidence; duplicate events are deduped, not double-applied.
// Credible regression: if settle ever stopped requiring job completion, a
// provider could get paid for unstarted work; the accept->settle test pins
// the cross-dimension rule.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJobPayment, applyEvent, isTerminal, JOB_STATES, PAYMENT_STATES } from "../server/job-payment-state.mjs";

const ev = (eventId, type, data = {}) => ({ eventId, type, data });
const receipt = { jobId: "job-1", signature: "sig" };

function happyPath() {
  let r = createJobPayment({ jobId: "job-1", payer: "buyer", payee: "provider" });
  for (const e of [
    ev("e1", "payment.funded", { amountRaw: "50000" }),
    ev("e2", "job.accepted"),
    ev("e3", "job.started"),
    ev("e4", "job.completed"),
    ev("e5", "payment.settled", { receipt }),
  ]) {
    r = applyEvent(r, e).record;
  }
  return r;
}

describe("job/payment state machine", () => {
  it("accept -> settle: full happy path reaches (completed, settled)", () => {
    const r = happyPath();
    assert.equal(r.job, "completed");
    assert.equal(r.payment, "settled");
    assert.equal(isTerminal(r), true);
    assert.equal(r.history.length, 5);
  });

  it("accept -> dispute: funded payment can be disputed and resolved either way", () => {
    let r = createJobPayment({ jobId: "job-2", payer: "b", payee: "p" });
    r = applyEvent(r, ev("e1", "payment.funded", { amountRaw: "100" })).record;
    r = applyEvent(r, ev("e2", "job.accepted")).record;
    r = applyEvent(r, ev("e3", "payment.disputed", { reason: "work not delivered" })).record;
    assert.equal(r.payment, "disputed");
    // resolve -> refund (job never completed)
    r = applyEvent(r, ev("e4", "payment.dispute_resolved", { outcome: "refund" })).record;
    assert.equal(r.payment, "refunded");
    assert.equal(isTerminal(r), true);
  });

  it("dispute can resolve to release when the job completed", () => {
    let r = createJobPayment({ jobId: "job-3", payer: "b", payee: "p" });
    for (const e of [
      ev("e1", "payment.funded", { amountRaw: "100" }),
      ev("e2", "job.accepted"),
      ev("e3", "job.started"),
      ev("e4", "job.completed"),
      ev("e5", "payment.disputed", { reason: "buyer remorse" }),
      ev("e6", "payment.dispute_resolved", { outcome: "release" }),
    ]) r = applyEvent(r, e).record;
    assert.equal(r.payment, "settled");
  });

  it("fund -> cancel -> refund: cancellation before acceptance refunds", () => {
    let r = createJobPayment({ jobId: "job-4", payer: "b", payee: "p" });
    r = applyEvent(r, ev("e1", "payment.funded", { amountRaw: "100" })).record;
    r = applyEvent(r, ev("e2", "job.cancelled")).record;
    assert.equal(r.job, "cancelled");
    r = applyEvent(r, ev("e3", "payment.refunded", { reason: "buyer cancelled" })).record;
    assert.equal(r.payment, "refunded");
  });

  it("duplicate-event dedup: replaying an eventId does not double-apply", () => {
    let r = createJobPayment({ jobId: "job-5", payer: "b", payee: "p" });
    const first = applyEvent(r, ev("e1", "payment.funded", { amountRaw: "100" }));
    assert.equal(first.deduped, false);
    const second = applyEvent(first.record, ev("e1", "payment.funded", { amountRaw: "100" }));
    assert.equal(second.deduped, true);
    assert.equal(second.record.history.length, 1);
    // A replayed settle with a DIFFERENT receipt is still deduped: eventId wins.
    let s = applyEvent(second.record, ev("e2", "job.accepted")).record;
    s = applyEvent(s, ev("e3", "job.started")).record;
    s = applyEvent(s, ev("e4", "job.completed")).record;
    const receipt5 = { jobId: "job-5", signature: "sig" };
    const settle = applyEvent(s, ev("e5", "payment.settled", { receipt: receipt5 }));
    assert.equal(applyEvent(settle.record, ev("e5", "payment.settled", { receipt: { jobId: "job-5", signature: "other" } })).deduped, true);
  });

  it("settle requires job completion: cannot pay for unstarted work", () => {
    let r = createJobPayment({ jobId: "job-6", payer: "b", payee: "p" });
    r = applyEvent(r, ev("e1", "payment.funded", { amountRaw: "100" })).record;
    r = applyEvent(r, ev("e2", "job.accepted")).record;
    assert.throws(() => applyEvent(r, ev("e3", "payment.settled", { receipt })), /need completed/);
  });

  it("settle requires receipt evidence", () => {
    let r = createJobPayment({ jobId: "job-7", payer: "b", payee: "p" });
    for (const e of [ev("e1", "payment.funded", { amountRaw: "100" }), ev("e2", "job.accepted"), ev("e3", "job.started"), ev("e4", "job.completed")]) {
      r = applyEvent(r, e).record;
    }
    assert.throws(() => applyEvent(r, ev("e5", "payment.settled", {})), /requires data\.receipt/);
    assert.throws(() => applyEvent(r, ev("e5", "payment.settled", { receipt: { jobId: "other", signature: "x" } })), /different job/);
  });

  it("cannot fund after the job finished, cannot cancel a completed job", () => {
    let r = createJobPayment({ jobId: "job-8", payer: "b", payee: "p" });
    for (const e of [ev("e1", "job.accepted"), ev("e2", "job.started"), ev("e3", "job.completed")]) {
      r = applyEvent(r, e).record;
    }
    assert.throws(() => applyEvent(r, ev("e4", "payment.funded", { amountRaw: "1" })), /cannot fund when job is completed/);
    assert.throws(() => applyEvent(r, ev("e5", "job.cancelled")), /cannot cancel a completed job/);
  });

  it("unknown events and malformed inputs fail closed", () => {
    const r = createJobPayment({ jobId: "job-9", payer: "b", payee: "p" });
    assert.throws(() => applyEvent(r, ev("e1", "payment.teleported")), /unknown event type/);
    assert.throws(() => applyEvent(r, { type: "job.accepted" }), /eventId required/);
    assert.throws(() => createJobPayment({ jobId: "x" }), /payer, payee required/);
  });

  it("exposes the documented state vocabularies", () => {
    assert.deepEqual([...JOB_STATES], ["proposed", "accepted", "in_progress", "completed", "failed", "cancelled"]);
    assert.deepEqual([...PAYMENT_STATES], ["unfunded", "funded", "settled", "refunded", "disputed"]);
  });
});
