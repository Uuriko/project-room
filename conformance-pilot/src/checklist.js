/**
 * ROOM-CONFORMANCE-PILOT-DESIGN checklist.
 * Named here so the skeleton documents the intended run without executing it.
 *
 * Full execution is blocked on a published Phase 0 (#8) tip.
 * This package must not import server/, src/, or rewrite contribution-rollup (#17).
 */

export const CHECKLIST = Object.freeze([
  Object.freeze({
    id: "recovery",
    title: "Recovery",
    sources: [
      "../docs/EVENT-FIXTURES.md#recovery-cases-to-exercise-in-the-first-implementation",
      "../docs/SPEC-v0.md#runtime-and-recovery",
      "docs/SERVICE.md (Phase 0 tip — restart / WAL / replay)"
    ],
    requires: [
      "Second member joins without a pasted recap",
      "Unavailable worker preserves last confirmed step",
      "Restart reconstructs the view from stored Events and issues no external actions",
      "Duplicate receipt stays one logical receipt"
    ]
  }),
  Object.freeze({
    id: "honesty",
    title: "Honesty",
    sources: [
      "../docs/EVENT-FIXTURES.md#work-state-and-authority",
      "../docs/SPEC-v0.md",
      "docs/SERVICE.md (Phase 0 tip — honest limits and unknown outcomes)"
    ],
    requires: [
      "Unknown producer / provenance stays a visible gap",
      "Reporter is never inferred as producer",
      "No invented PASS, merge, metric, or approval",
      "Failed, pending, or unknown outcomes are not claimed as success"
    ]
  }),
  Object.freeze({
    id: "c1-c4-verification-first",
    title: "C1–C4 verification-first",
    sources: [
      "../docs/EVENT-FIXTURES.md",
      "contribution-rollup C1–C4 (conceptual; do not merge #17)"
    ],
    requires: [
      "C1 happy: known producer complete + artifact, designated verify, designated decide",
      "C2 double-count: same Event id or same source + payload adds no weight",
      "C3 forged actor: client actor, display label, or message prefix mints no share",
      "C4 unknown producer: no complete/artifact share; gap stays visible",
      "Verification-first: designated verifier PASS on that exact version before complete/artifact weight"
    ]
  }),
  Object.freeze({
    id: "contributors-events-only",
    title: "Contributors Events-only",
    sources: [
      "../docs/EVENT-FIXTURES.md",
      "../docs/SPEC-v0.md"
    ],
    requires: [
      "Contributors is a read-model over existing Events",
      "Weight kinds are complete / verify / decide / artifact only",
      "Message and acknowledgment volume add zero weight",
      "No disconnected scoreboard or payout invent"
    ]
  })
]);

export const CHECKLIST_IDS = Object.freeze(CHECKLIST.map((item) => item.id));
