// Command admission gate (WAVE-300 item 2 — honest backpressure).
//
// Pure, dependency-free in-flight gauge that POST /commands consults before
// buffering a request body or touching the store. When the gauge is full the
// server refuses FAST with a 503 (shed_load) instead of silently queueing
// behind the single-threaded loop / SQLite write lock — you can't back off
// from silence.
//
// The gate is global to the server instance: the bottleneck is the event
// loop and the write lock, not the room being posted to.
//
// Injectable `now` keeps the module unit-testable with zero server imports.
// All returned objects are frozen.
const DEFAULT_MAX_INFLIGHT = 16;
// Constant, documented: a shed client waits this long before retrying. The
// HTTP layer mirrors it into the Retry-After header (whole seconds).
const DEFAULT_RETRY_AFTER_MS = 1000;

export function createCommandAdmission({ maxInFlight = DEFAULT_MAX_INFLIGHT, now } = {}) {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 0)
    throw new TypeError("maxInFlight must be a non-negative integer");
  const clock = now ?? Date.now;
  let inFlight = 0;
  let shed = 0;
  return {
    // Admit one command for processing. Returns { admitted: true } and
    // increments the gauge, or refuses without consuming capacity:
    // { admitted: false, retryAfterMs, inFlight }.
    enter() {
      if (inFlight >= maxInFlight) {
        shed += 1;
        return Object.freeze({ admitted: false, retryAfterMs: DEFAULT_RETRY_AFTER_MS, inFlight });
      }
      inFlight += 1;
      return Object.freeze({ admitted: true });
    },
    // Release one slot. Never drops below zero; extra leaves are harmless
    // no-ops so a defensive double-leave cannot corrupt the gauge.
    leave() {
      inFlight = Math.max(0, inFlight - 1);
      return inFlight;
    },
    state() {
      return Object.freeze({ inFlight, maxInFlight, shed, now: clock() });
    },
  };
}
