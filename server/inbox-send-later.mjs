// Inbox scheduled send (Superhuman-style send-later). An in-memory,
// fixture-driven scheduled-send store: schedule / cancel / list, a due-sweep
// query with claim semantics (no double-send), a sent transition, and an
// undo-send window after sending. Pure apart from the injected clock; no
// network I/O, no secrets. Frozen outputs.
//
// Lifecycle: scheduled → ready → sent → (draft, via undo inside the window)
//            scheduled → cancelled
//            ready → failed
class SendLaterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SendLaterError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new SendLaterError(code, message);
};
const check = (condition, code, message) => {
  if (!condition) fail(code, message);
};

export const SCHEDULE_STATES = Object.freeze(["scheduled", "ready", "sent", "failed", "cancelled", "draft"]);
export const UNDO_WINDOW_MS = 30 * 1000;
export const MAX_SCHEDULED = 1000;
export const MAX_HORIZON_MS = 365 * 86400000;

const checkId = value => {
  check(typeof value === "string" && value.length > 0 && value.length <= 512, "SL_INVALID_INPUT", "id must be 1..512 characters");
};
const checkMessage = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "SL_INVALID_INPUT", "message must be an object");
  checkId(value.id);
};

const snapshot = record =>
  Object.freeze({
    id: record.id,
    message: record.message,
    sendAt: record.sendAt,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sentAt: record.sentAt,
    cancelReason: record.cancelReason,
    failReason: record.failReason,
  });

/**
 * Create an in-memory scheduled-send store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock] ms epoch; default Date.now
 * @param {() => string} [deps.id] id generator
 */
export function createSendLaterStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  let counter = 0;
  const newId = deps.id ?? (() => `send-later-${(counter += 1)}`);
  const records = new Map();

  const getOrThrow = id => {
    checkId(id);
    const record = records.get(id);
    if (!record) fail("SL_UNKNOWN_SCHEDULE", `Unknown scheduled send ${id}`);
    return record;
  };

  const store = {
    /** Schedule a message for future send. Returns the frozen record. */
    schedule(message, { sendAt, id = null } = {}) {
      checkMessage(message);
      check(Number.isSafeInteger(sendAt), "SL_INVALID_INPUT", "sendAt must be a safe integer ms epoch");
      const now = clock();
      check(sendAt > now, "SL_INVALID_INPUT", "sendAt must be in the future");
      check(sendAt <= now + MAX_HORIZON_MS, "SL_INVALID_INPUT", "sendAt is beyond the one-year horizon");
      check(records.size < MAX_SCHEDULED, "SL_CAPACITY", "Scheduled-send capacity reached");
      const recordId = id ?? newId();
      checkId(recordId);
      check(!records.has(recordId), "SL_DUPLICATE_ID", `Schedule id ${recordId} already exists`);
      const record = {
        id: recordId,
        message: Object.freeze({ ...message }),
        sendAt,
        state: "scheduled",
        createdAt: now,
        updatedAt: now,
        sentAt: null,
        cancelReason: null,
        failReason: null,
      };
      records.set(recordId, record);
      return snapshot(record);
    },

    /** Cancel a scheduled send that has not been sent yet. */
    cancel(id, { reason = null } = {}) {
      const record = getOrThrow(id);
      check(record.state === "scheduled", "SL_BAD_TRANSITION",
        `Cannot cancel a send in state '${record.state}'`);
      if (reason !== null) check(typeof reason === "string" && reason.length <= 512, "SL_INVALID_INPUT", "reason must be a short string");
      record.state = "cancelled";
      record.cancelReason = reason;
      record.updatedAt = clock();
      return snapshot(record);
    },

    /**
     * Due-sweep query: all 'scheduled' records with sendAt <= now, oldest
     * first. Does not mutate; call take() to claim them for sending.
     */
    due(now = clock()) {
      check(Number.isSafeInteger(now), "SL_INVALID_INPUT", "now must be a safe integer ms epoch");
      return Object.freeze(
        [...records.values()]
          .filter(record => record.state === "scheduled" && record.sendAt <= now)
          .sort((a, b) => a.sendAt - b.sendAt || (a.id < b.id ? -1 : 1))
          .map(snapshot)
      );
    },

    /**
     * Claim due records for the sender (scheduled → ready). Idempotent for
     * already-claimed ids; unknown ids throw.
     */
    take(ids) {
      check(Array.isArray(ids), "SL_INVALID_INPUT", "ids must be a list");
      const now = clock();
      return Object.freeze(ids.map(id => {
        const record = getOrThrow(id);
        check(record.state === "scheduled" || record.state === "ready", "SL_BAD_TRANSITION",
          `Cannot take a send in state '${record.state}'`);
        if (record.state === "scheduled") {
          record.state = "ready";
          record.updatedAt = now;
        }
        return snapshot(record);
      }));
    },

    /** Mark a claimed send as delivered. */
    complete(id) {
      const record = getOrThrow(id);
      check(record.state === "ready", "SL_BAD_TRANSITION", `Cannot complete a send in state '${record.state}'`);
      record.state = "sent";
      record.sentAt = clock();
      record.updatedAt = record.sentAt;
      return snapshot(record);
    },

    /** Mark a claimed send as failed (retryable later via reschedule). */
    failSend(id, { reason = null } = {}) {
      const record = getOrThrow(id);
      check(record.state === "ready", "SL_BAD_TRANSITION", `Cannot fail a send in state '${record.state}'`);
      if (reason !== null) check(typeof reason === "string" && reason.length <= 512, "SL_INVALID_INPUT", "reason must be a short string");
      record.state = "failed";
      record.failReason = reason;
      record.updatedAt = clock();
      return snapshot(record);
    },

    /**
     * Undo a just-sent message: within UNDO_WINDOW_MS of sentAt the send is
     * pulled back to 'draft' (unsent); after the window it throws
     * SL_UNDO_EXPIRED and stays sent.
     */
    undo(id) {
      const record = getOrThrow(id);
      check(record.state === "sent", "SL_BAD_TRANSITION", `Cannot undo a send in state '${record.state}'`);
      const now = clock();
      check(now - record.sentAt <= UNDO_WINDOW_MS, "SL_UNDO_EXPIRED",
        `Undo window of ${UNDO_WINDOW_MS}ms has expired`);
      record.state = "draft";
      record.sentAt = null;
      record.updatedAt = now;
      return snapshot(record);
    },

    /** List all records, optionally filtered by state. */
    list({ state = null } = {}) {
      if (state !== null) check(SCHEDULE_STATES.includes(state), "SL_INVALID_INPUT", `Unknown state '${state}'`);
      return Object.freeze(
        [...records.values()]
          .filter(record => state === null || record.state === state)
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(snapshot)
      );
    },

    /** Read one record (null when unknown). */
    get(id) {
      if (typeof id !== "string") return null;
      const record = records.get(id);
      return record ? snapshot(record) : null;
    },

    /** Live counts by state. */
    counts() {
      const counts = Object.fromEntries(SCHEDULE_STATES.map(state => [state, 0]));
      for (const record of records.values()) counts[record.state] += 1;
      return Object.freeze(counts);
    },
  };

  return Object.freeze(store);
}

export { SendLaterError };
