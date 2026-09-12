/**
 * Tiny conceptual stub of the Contributors read-model.
 *
 * Mirrors the #17 `contributorsForReturnBrief` shape without importing
 * contribution-rollup or rewriting that package. Events-only. Messages
 * and acknowledgments never mint.
 *
 * Full derivation waits on a published #8 tip. Do not merge #17 here.
 */

export const WEIGHT_KINDS = Object.freeze(["complete", "verify", "decide", "artifact"]);

export function contributorsForReturnBrief(_events = {}, _options = {}) {
  return {
    lines: [],
    gaps: [],
    member_shares: [],
    active_weight: 0,
    status: "blocked",
    reason: "blocked on published #8 tip for full run"
  };
}
