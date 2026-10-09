// TEST-ONLY fault injection for crash-recovery property tests.
//
// DO NOT ARM IN PRODUCTION. This module exists so tests can simulate a
// process crash at an exact commit-boundary point WITHOUT real kills:
// arm named fault points, run the op, and the boundary throws a
// ChaosFaultError at the armed point — the test then closes the database,
// reopens it ("restart"), and retries, exactly as a crashed-and-restarted
// process would.
//
// Safety contract:
// - Production code imports ONLY chaosFaultPoint(), which is a single
//   no-op branch when nothing is armed (module-local state, off by default).
// - The arm/disarm functions (__testOnly*) are imported ONLY by tests under
//   tests/chaos/. No production caller arms faults, ever.
// - A fault that fires throws; it never silently alters behavior. If a test
//   forgets to disarm, the next armed assertion fails loudly instead of
//   passing vacuously (tests assert the fault actually fired).
//
// Precedent: server/session-adapter.mjs `_simulateEventsLost` documents the
// same TEST-ONLY hook convention for its recovery path.

export class ChaosFaultError extends Error {
  constructor(faultPoint, context) {
    super(`chaos fault injected at ${faultPoint} (simulated crash — process would die here)`);
    this.name = "ChaosFaultError";
    this.faultPoint = faultPoint;
    this.context = context ?? null;
  }
}

// Module-local arm state. Null = disarmed (the production steady state).
let armed = null;
let fired = [];

const normalizePoints = spec => {
  if (Array.isArray(spec)) return new Set(spec);
  if (spec && typeof spec === "object" && Array.isArray(spec.points)) return new Set(spec.points);
  throw new TypeError("__testOnlyArmFaults expects an array of fault-point names or { points: [...] }");
};

/**
 * TEST-ONLY: arm fault points. Every chaosFaultPoint(name) hit while armed
 * throws ChaosFaultError. Resets the fired-point record. Tests must disarm
 * (try/finally) when the op under test is done.
 */
export function __testOnlyArmFaults(spec) {
  armed = normalizePoints(spec);
  fired = [];
}

/** TEST-ONLY: disarm all fault points. The fired-point record is kept for post-assert. */
export function __testOnlyDisarmFaults() {
  armed = null;
}

/** TEST-ONLY: names of fault points that fired since arming, in order. */
export function __testOnlyFaultsFired() {
  return [...fired];
}

/**
 * Commit-boundary fault point. Production call sites invoke this at the exact
 * spot a crash is simulated (e.g. after the idempotency-key INSERT, before the
 * provider delivery). Disarmed (production): returns immediately. Armed and
 * the point matches: records the firing and throws ChaosFaultError.
 */
export function chaosFaultPoint(name, context) {
  if (armed === null || !armed.has(name)) return;
  fired.push(name);
  throw new ChaosFaultError(name, context);
}
