// Job-acceptance vs payment-finality state machine (200-hard-tasks #5).
// Two orthogonal dimensions with explicit cross-dimension rules: the JOB
// lifecycle (proposed -> accepted -> in_progress -> completed|failed|cancelled)
// is separate from the PAYMENT lifecycle
// (unfunded -> funded -> settled|refunded, with disputed as an overlay).
// Events are applied idempotently: a duplicate eventId returns the record
// unchanged (deduped: true) instead of double-applying. Pure, no I/O.
export const JOB_STATES = Object.freeze(["proposed", "accepted", "in_progress", "completed", "failed", "cancelled"]);
export const PAYMENT_STATES = Object.freeze(["unfunded", "funded", "settled", "refunded", "disputed"]);

const JOB_TRANSITIONS = {
  proposed: ["accepted", "cancelled"],
  accepted: ["in_progress", "cancelled"],
  in_progress: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class StateMachineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function createJobPayment({ jobId, payer, payee }) {
  if (!jobId || !payer || !payee) throw new StateMachineError("INVALID", "jobId, payer, payee required");
  return Object.freeze({
    jobId,
    payer,
    payee,
    job: "proposed",
    payment: "unfunded",
    receipt: null,
    dispute: null,
    seenEvents: [],
    history: [],
  });
}

function withUpdate(record, patch, event) {
  return Object.freeze({
    ...record,
    ...patch,
    seenEvents: [...record.seenEvents, event.eventId],
    history: [...record.history, { eventId: event.eventId, type: event.type, at: event.at || new Date().toISOString(), job: patch.job ?? record.job, payment: patch.payment ?? record.payment }],
  });
}

function need(cond, code, message, details) {
  if (!cond) throw new StateMachineError(code, message, details);
}

// event: { eventId, type, at?, data? }
// Returns { record, deduped } — deduped true when eventId was already applied.
export function applyEvent(record, event) {
  if (!event || typeof event.eventId !== "string" || !event.eventId) {
    throw new StateMachineError("INVALID", "event.eventId required");
  }
  if (record.seenEvents.includes(event.eventId)) {
    return { record, deduped: true }; // duplicate-event dedup: replay protection
  }
  const data = event.data || {};
  const moveJob = (to) => {
    need(JOB_TRANSITIONS[record.job].includes(to), "ILLEGAL_JOB_TRANSITION",
      `job cannot move ${record.job} -> ${to}`, { from: record.job, to });
    return withUpdate(record, { job: to }, event);
  };

  switch (event.type) {
    case "job.accepted":
      return { record: moveJob("accepted"), deduped: false };
    case "job.started":
      return { record: moveJob("in_progress"), deduped: false };
    case "job.completed":
      return { record: moveJob("completed"), deduped: false };
    case "job.failed":
      return { record: moveJob("failed"), deduped: false };
    case "job.cancelled": {
      need(record.job !== "completed", "ILLEGAL_JOB_TRANSITION", "cannot cancel a completed job", { job: record.job });
      return { record: moveJob("cancelled"), deduped: false };
    }
    case "payment.funded": {
      need(["proposed", "accepted", "in_progress"].includes(record.job), "ILLEGAL_PAYMENT_TRANSITION",
        `cannot fund when job is ${record.job}`, { job: record.job });
      need(record.payment === "unfunded", "ILLEGAL_PAYMENT_TRANSITION",
        `payment already ${record.payment}`, { payment: record.payment });
      need(data.amountRaw && /^\d+$/.test(String(data.amountRaw)), "INVALID",
        "payment.funded requires data.amountRaw as integer string");
      return { record: withUpdate(record, { payment: "funded" }, event), deduped: false };
    }
    case "payment.settled": {
      // accept -> settle: job must be complete AND payment funded.
      need(record.job === "completed", "ILLEGAL_PAYMENT_TRANSITION",
        `cannot settle when job is ${record.job} (need completed)`, { job: record.job });
      need(record.payment === "funded", "ILLEGAL_PAYMENT_TRANSITION",
        `cannot settle when payment is ${record.payment} (need funded)`, { payment: record.payment });
      need(data.receipt && typeof data.receipt === "object", "RECEIPT_REQUIRED",
        "payment.settled requires data.receipt (settlement receipt, task #4)");
      need(data.receipt.jobId === record.jobId, "RECEIPT_MISMATCH",
        "settlement receipt is for a different job", { receiptJob: data.receipt.jobId });
      return { record: withUpdate(record, { payment: "settled", receipt: data.receipt }, event), deduped: false };
    }
    case "payment.disputed": {
      need(["funded", "settled"].includes(record.payment), "ILLEGAL_PAYMENT_TRANSITION",
        `cannot dispute when payment is ${record.payment}`, { payment: record.payment });
      need(data.reason, "INVALID", "payment.disputed requires data.reason");
      return { record: withUpdate(record, { payment: "disputed", dispute: { reason: data.reason, at: event.at || new Date().toISOString() } }, event), deduped: false };
    }
    case "payment.dispute_resolved": {
      need(record.payment === "disputed", "ILLEGAL_PAYMENT_TRANSITION",
        `cannot resolve dispute when payment is ${record.payment}`, { payment: record.payment });
      need(data.outcome === "release" || data.outcome === "refund", "INVALID",
        "payment.dispute_resolved requires data.outcome 'release'|'refund'");
      if (data.outcome === "release") {
        need(record.job === "completed", "ILLEGAL_PAYMENT_TRANSITION",
          "dispute can only resolve to release when the job completed", { job: record.job });
        return { record: withUpdate(record, { payment: "settled", dispute: null }, event), deduped: false };
      }
      return { record: withUpdate(record, { payment: "refunded", dispute: null }, event), deduped: false };
    }
    case "payment.refunded": {
      // fund -> cancel -> refund, or funded -> refund (cancel before accept).
      need(["funded", "disputed"].includes(record.payment), "ILLEGAL_PAYMENT_TRANSITION",
        `cannot refund when payment is ${record.payment}`, { payment: record.payment });
      need(data.reason, "INVALID", "payment.refunded requires data.reason");
      return { record: withUpdate(record, { payment: "refunded", dispute: null }, event), deduped: false };
    }
    default:
      throw new StateMachineError("UNKNOWN_EVENT", `unknown event type: ${event.type}`, { type: event.type });
  }
}

export function isTerminal(record) {
  return ["settled", "refunded"].includes(record.payment);
}
