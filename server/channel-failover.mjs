// Channel failover (A022). A pure retry queue with exponential backoff for
// outbound provider sends: when a provider is down, messages queue instead
// of being silently dropped. Each queued item tracks attempts, next-retry
// time (exponential backoff with jitter bounds), and a dead-letter state
// after max attempts. The queue is caller-owned (a Map); this module is
// pure and dependency-free. Time is injectable for tests. Frozen outputs;
// malformed inputs throw FailoverError. Provider send wiring is a later
// slice.
const DEFAULTS = Object.freeze({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 300000 });
class FailoverError extends Error { constructor(code, message) { super(message); this.name = "FailoverError"; this.code = code; } }
const fail = (code, message) => { throw new FailoverError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_failover", message); };

// Compute the delay before the next retry. attempt is 1-based.
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs } = {}) {
  check(Number.isInteger(attempt) && attempt >= 1, "attempt must be a positive integer");
  const base = baseDelayMs ?? DEFAULTS.baseDelayMs, max = maxDelayMs ?? DEFAULTS.maxDelayMs;
  check(Number.isFinite(base) && base > 0, "baseDelayMs must be positive");
  check(Number.isFinite(max) && max >= base, "maxDelayMs must be >= baseDelayMs");
  return Math.min(max, base * 2 ** (attempt - 1));
}
// Create a failover queue. store is a caller-owned Map (id -> item).
export function createFailoverQueue({ maxAttempts, baseDelayMs, maxDelayMs, store } = {}) {
  const maxA = maxAttempts ?? DEFAULTS.maxAttempts;
  check(Number.isInteger(maxA) && maxA >= 1, "maxAttempts must be a positive integer");
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const items = store ?? new Map();
  const config = { baseDelayMs: baseDelayMs ?? DEFAULTS.baseDelayMs, maxDelayMs: maxDelayMs ?? DEFAULTS.maxDelayMs };
  // Enqueue a message for delivery. Returns the queued item.
  const enqueue = (message, { now } = {}) => {
    check(message !== null && typeof message === "object", "message must be an object");
    check(typeof message.id === "string" && message.id.length > 0, "message needs an id");
    check(typeof message.channel === "string" && message.channel.length > 0, "message needs a channel");
    check(!items.has(message.id), `message "${message.id}" is already queued`);
    const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
    check(!Number.isNaN(at), "now must be parseable");
    const item = Object.freeze({ id: message.id, channel: message.channel, payload: message.payload ?? null,
      attempts: 0, nextRetryAt: new Date(at).toISOString(), state: "queued" });
    items.set(message.id, item);
    return item;
  };
  // Record a failed attempt. Returns the updated item (state: queued with
  // nextRetryAt, or dead-letter when attempts are exhausted).
  const recordFailure = (id, { now, error } = {}) => {
    check(typeof id === "string" && items.has(id), `unknown queued message "${id}"`);
    const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
    check(!Number.isNaN(at), "now must be parseable");
    const current = items.get(id);
    const attempts = current.attempts + 1;
    const exhausted = attempts >= maxA;
    const item = Object.freeze({ ...current, attempts,
      state: exhausted ? "dead-letter" : "queued",
      nextRetryAt: new Date(at + (exhausted ? 0 : backoffDelay(attempts, config))).toISOString(),
      lastError: error ?? null });
    items.set(id, item);
    return item;
  };
  // Record a successful delivery. Removes the item and returns it.
  const recordSuccess = id => {
    check(typeof id === "string" && items.has(id), `unknown queued message "${id}"`);
    const item = items.get(id);
    items.delete(id);
    return Object.freeze({ ...item, state: "delivered" });
  };
  // Items ready to retry at `now`.
  const dueItems = ({ now } = {}) => {
    const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
    check(!Number.isNaN(at), "now must be parseable");
    return Object.freeze([...items.values()]
      .filter(item => item.state === "queued" && new Date(item.nextRetryAt).getTime() <= at));
  };
  return Object.freeze({ enqueue, recordFailure, recordSuccess, dueItems,
    size: () => items.size, config: Object.freeze({ maxAttempts: maxA, ...config }) });
}
export { FailoverError, DEFAULTS };
