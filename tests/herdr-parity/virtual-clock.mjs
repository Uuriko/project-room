// Deterministic virtual clock shared by both parity runs.
// Both drivers advance it on the same schedule, so every timestamp in the
// two traces is identical by construction — parity asserts exact equality,
// never fuzzy time matching.
export const T0 = 1_750_000_000_000;
export const STEP_MS = 60_000;

export function createVirtualClock(t0 = T0) {
  let at = t0;
  return {
    now: () => at,
    iso: () => new Date(at).toISOString(),
    tick: (ms = STEP_MS) => { at += ms; return at; },
    at: () => at,
  };
}
