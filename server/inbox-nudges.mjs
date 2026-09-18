// Inbox follow-up nudges (Superhuman-style "no reply" detection). Pure,
// fixture-driven detection over thread snapshots: a thread nudges when the
// last message is mine (outbound) and no reply arrived within the follow-up
// threshold. This is NOT server/reminders.mjs — that module is work-item
// reminder receipts with idempotency; this one scans message threads for
// stale conversations awaiting a reply. No network I/O, no secrets.
class NudgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NudgeError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new NudgeError(code, message);
};
const check = (condition, code, message) => {
  if (!condition) fail(code, message);
};

export const NUDGE_KINDS = Object.freeze(["awaiting_reply"]);
export const DEFAULT_FOLLOWUP_THRESHOLD_MS = 48 * 60 * 60 * 1000;
export const VIP_FOLLOWUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const MAX_THREADS = 10000;

const checkThread = thread => {
  check(thread !== null && typeof thread === "object" && !Array.isArray(thread), "NUDGE_INVALID_INPUT", "thread must be an object");
  check(typeof thread.id === "string" && thread.id.length > 0 && thread.id.length <= 512, "NUDGE_INVALID_INPUT", "thread id must be 1..512 characters");
  check(Array.isArray(thread.messages) && thread.messages.length > 0, "NUDGE_INVALID_INPUT", "thread must have at least one message");
  for (const message of thread.messages) {
    check(message !== null && typeof message === "object", "NUDGE_INVALID_INPUT", "thread messages must be objects");
    check(message.direction === "in" || message.direction === "out", "NUDGE_INVALID_INPUT", "message direction must be 'in' or 'out'");
    check(Number.isSafeInteger(message.sentAt), "NUDGE_INVALID_INPUT", "message sentAt must be a safe integer ms epoch");
  }
  return thread;
};

const isVip = (thread, vipSenders) => {
  const sender = thread.messages[thread.messages.length - 1].sender;
  return typeof sender === "string" && vipSenders.has(sender);
};

// One nudge record per thread. A thread nudges only when the LAST message is
// outbound (I sent the final word) and its age exceeds the threshold — i.e.
// I am waiting on them. Threads whose last message is inbound are someone
// waiting on me; that is triage/priority territory, not a follow-up nudge.
export function nudgeForThread(thread, { now, followUpThresholdMs = DEFAULT_FOLLOWUP_THRESHOLD_MS, vipSenders = new Set() } = {}) {
  const checked = checkThread(thread);
  check(Number.isSafeInteger(now), "NUDGE_INVALID_INPUT", "now must be a safe integer ms epoch");
  const vips = vipSenders instanceof Set ? vipSenders : new Set(Array.isArray(vipSenders) ? vipSenders : []);
  const last = checked.messages[checked.messages.length - 1];
  if (last.direction !== "out") return null;
  const vip = isVip(checked, vips);
  const threshold = vip ? Math.min(followUpThresholdMs, VIP_FOLLOWUP_THRESHOLD_MS) : followUpThresholdMs;
  const ageMs = Math.max(0, now - last.sentAt);
  if (ageMs < threshold) return null;
  const urgency = ageMs >= threshold * 2 ? "high" : "normal";
  return Object.freeze({
    threadId: checked.id,
    kind: "awaiting_reply",
    lastMessageAt: last.sentAt,
    ageMs,
    thresholdMs: threshold,
    vip,
    urgency,
    // How overdue the follow-up is, as a multiple of the threshold (>= 1).
    overdueRatio: ageMs / threshold,
  });
}

/** Scan a thread list, returning nudge records sorted most-overdue first. */
export function scanThreads(threads, options = {}) {
  check(Array.isArray(threads) && threads.length <= MAX_THREADS, "NUDGE_INVALID_INPUT", `threads must be a list of at most ${MAX_THREADS}`);
  const vipSenders = options.vipSenders instanceof Set
    ? options.vipSenders
    : new Set(Array.isArray(options.vipSenders) ? options.vipSenders : []);
  const nudges = [];
  for (const thread of threads) {
    const nudge = nudgeForThread(thread, { ...options, vipSenders });
    if (nudge) nudges.push(nudge);
  }
  nudges.sort((a, b) => b.overdueRatio - a.overdueRatio || (a.threadId < b.threadId ? -1 : 1));
  return Object.freeze(nudges);
}

/**
 * Stateful nudge tracker: wraps scanThreads with dismissal memory so a
 * dismissed thread stays quiet until it sees new activity.
 */
export function createNudgeTracker(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const dismissed = new Map(); // threadId -> lastMessageAt seen at dismissal

  const tracker = {
    /** Scan, excluding threads dismissed since their last activity. */
    scan(threads, options = {}) {
      const nudges = scanThreads(threads, { ...options, now: options.now ?? clock() });
      return Object.freeze(nudges.filter(nudge => dismissed.get(nudge.threadId) !== nudge.lastMessageAt));
    },
    /** Dismiss a nudge; it returns only if the thread gets a newer message. */
    dismiss(threadId, lastMessageAt) {
      check(typeof threadId === "string" && threadId.length > 0, "NUDGE_INVALID_INPUT", "threadId must be a non-empty string");
      check(Number.isSafeInteger(lastMessageAt), "NUDGE_INVALID_INPUT", "lastMessageAt must be a safe integer ms epoch");
      dismissed.set(threadId, lastMessageAt);
      return Object.freeze({ threadId, dismissedUntil: lastMessageAt });
    },
    /** Forget a dismissal (the thread nudges again on the next scan). */
    undismiss(threadId) {
      check(typeof threadId === "string" && threadId.length > 0, "NUDGE_INVALID_INPUT", "threadId must be a non-empty string");
      return dismissed.delete(threadId);
    },
    /** Dismissed thread ids (frozen list). */
    dismissedIds() {
      return Object.freeze([...dismissed.keys()]);
    },
  };

  return Object.freeze(tracker);
}

export { NudgeError };
