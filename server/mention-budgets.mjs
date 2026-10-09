// FIX-79: per-sender notification budgets. One sender must not be able to
// spam the room with mention-bombs across many messages: each (room,
// sender) gets a token bucket of notification credits per time window, and
// one credit is spent per delivered mention notification. The bucket is
// spent ONCE per message for the whole fanout (store.planMentionFanout):
// the same delivered set drives mention tracking, agent wakes, activity
// rows, and human push, so one message costs its mention count exactly
// once. Exhaustion sheds the excess notifications silently — the post
// still lands; the withheld count rides the command response note.
// In-memory and LRU-bounded, so a long-lived process cannot accumulate a
// bucket per stale sender. A restart resets budgets: fail-open toward
// delivery, never toward dropping legitimate mentions.
// Numbers: 100 credits / 10 min / sender / room. At the per-message cap of
// 20, that is 5 fully-loaded mention messages per 10 minutes — generous
// for a human coordinator, exhausted in seconds by a mention-bomber.
// Budgets are per-sender, so one bomber never spends another's budget.
import { createLimiter } from "./token-bucket.mjs";
import { MAX_MENTIONS_PER_MESSAGE } from "./mention-lifecycle.mjs";

export const MENTION_NOTIFICATION_BUDGET = 100;
export const MENTION_NOTIFICATION_WINDOW_MS = 10 * 60 * 1000;
export const MENTION_BUDGET_CACHE_SIZE = 2048;

const budgetKey = (roomId, senderId) => `${roomId}:${senderId}`;

export function createMentionBudgetRegistry({ now = () => Date.now(), cacheSize = MENTION_BUDGET_CACHE_SIZE } = {}) {
  const buckets = new Map(); // budgetKey -> token-bucket state (caller-owned, LRU-managed)
  const limiter = createLimiter({
    rate: MENTION_NOTIFICATION_BUDGET / (MENTION_NOTIFICATION_WINDOW_MS / 1000),
    burst: MENTION_NOTIFICATION_BUDGET,
    store: buckets,
  });
  const size = Math.max(1, Math.floor(Number(cacheSize)) || MENTION_BUDGET_CACHE_SIZE);
  const evict = () => {
    while (buckets.size > size) buckets.delete(buckets.keys().next().value);
  };
  // Spend up to `count` notification credits for this sender in this room.
  // Returns a frozen { allowed, shed }. Never throws for bad input: a
  // budget failure must not fail the message it guards.
  const consume = ({ roomId, senderId, count, now: at } = {}) => {
    try {
      const n = Math.max(0, Math.floor(Number(count) || 0));
      if (typeof roomId !== "string" || !roomId || typeof senderId !== "string" || !senderId || n === 0) {
        return Object.freeze({ allowed: 0, shed: n });
      }
      const key = budgetKey(roomId, senderId);
      if (buckets.has(key)) { // LRU touch: most-recently-used goes last
        const state = buckets.get(key);
        buckets.delete(key);
        buckets.set(key, state);
      }
      const stamp = Number.isFinite(at) ? at : now();
      let allowed = 0;
      for (let i = 0; i < n; i++) {
        if (!limiter.tryTake(key, { now: stamp }).allowed) break;
        allowed++;
      }
      evict();
      return Object.freeze({ allowed, shed: n - allowed });
    } catch {
      return Object.freeze({ allowed: Math.max(0, Math.floor(Number(count) || 0)), shed: 0 });
    }
  };
  // Non-consuming snapshot for diagnostics: { remaining, retryAfterMs, fullAtMs }.
  const peek = ({ roomId, senderId, now: at } = {}) => {
    if (typeof roomId !== "string" || !roomId || typeof senderId !== "string" || !senderId) return null;
    return limiter.peek(budgetKey(roomId, senderId), { now: Number.isFinite(at) ? at : now() });
  };
  return Object.freeze({ consume, peek });
}

// Human-readable note for the command response when a message's mention
// fanout was truncated by the per-message cap, shed by the per-sender
// budget, or both. Pure; empty string when nothing happened.
export function mentionBudgetNote({ totalResolved = 0, delivered = 0, shed = 0, truncated = false } = {}) {
  const parts = [];
  if (truncated) {
    parts.push(`mention fanout truncated to the per-message cap of ${MAX_MENTIONS_PER_MESSAGE}: ` +
      `${totalResolved} @mentions resolved, ${delivered} notified`);
  }
  if (shed > 0) {
    parts.push(`notification budget exhausted: ${shed} mention notification(s) withheld for this sender ` +
      `(${MENTION_NOTIFICATION_BUDGET} per ${MENTION_NOTIFICATION_WINDOW_MS / 60000} min per room). The message was posted.`);
  }
  return parts.join(" ");
}
