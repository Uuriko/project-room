/**
 * bridge/lib/circuit.mjs — per-tenant circuit breaker (D3 §3.3, bridge side).
 *
 * Trip: 5 consecutive transport failures (timeout / 5xx-equivalent / connection
 * error) → OPEN. Open: calls fail fast with bridge_circuit_open. After
 * openMs, one ping probe is allowed through (half-open): success → closed,
 * failure → open for another window. Socket-level application errors (a live
 * server answering) do not count as failures.
 */
export class CircuitBreaker {
  constructor({ failureThreshold = 5, openMs = 60_000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
    this.states = new Map(); // name -> { failures, openedAt, halfOpenProbe }
  }
  _state(name) {
    let s = this.states.get(name);
    if (!s) { s = { failures: 0, openedAt: 0, halfOpenProbe: false }; this.states.set(name, s); }
    return s;
  }
  /**
   * @returns {'closed'|'open'|'probe'} — 'probe' means this caller owns the
   * half-open ping probe and must report its outcome.
   */
  canCall(name) {
    const s = this._state(name);
    if (s.openedAt === 0) return 'closed';
    if (Date.now() - s.openedAt < this.openMs) return 'open';
    if (s.halfOpenProbe) return 'open'; // a probe is already in flight
    s.halfOpenProbe = true;
    return 'probe';
  }
  recordSuccess(name) {
    const s = this._state(name);
    s.failures = 0; s.openedAt = 0; s.halfOpenProbe = false;
  }
  recordFailure(name) {
    const s = this._state(name);
    s.failures += 1;
    s.halfOpenProbe = false;
    if (s.openedAt !== 0 || s.failures >= this.failureThreshold) {
      // Re-open (or open) the window on threshold breach or failed probe.
      if (s.openedAt === 0 || Date.now() - s.openedAt >= this.openMs) {
        s.openedAt = Date.now();
        s.failures = 0;
      }
    }
  }
  isOpen(name) {
    return this.canCall(name) === 'open';
  }
}
