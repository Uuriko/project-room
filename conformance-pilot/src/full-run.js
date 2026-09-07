/**
 * Placeholder for the isolated conformance run.
 * The skeleton records the checklist. It does not start Phase 0,
 * import server/ or src/, or claim a published #8 tip.
 */

export function runConformancePilot() {
  return {
    executed: false,
    status: "blocked",
    reason: "blocked on published #8 tip for full run; no merge until Instinct tip",
    checklist: ["recovery", "honesty", "c1-c4-verification-first", "contributors-events-only"]
  };
}
