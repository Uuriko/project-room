// HUNT-COVERAGE (2026-10-18) — mutation-survivor pin for settlement
// readiness (server/claim-coordination.mjs).
//
//   M10 — pullsReadyToSettle without its non-empty guard: [].every() is
//         vacuously true, so a claim with NO pull links read as ready to
//         settle. The mutation survived the settle suites (17 tests)
//         including the missing-link suite, and a wider net (37 tests:
//         settlement-stamp, pr-link, ready-queue, rate-limit) — those pin
//         missing-link behaviour at the route level, not this predicate.
//         A link-less claim must never be settle-ready: readiness is a
//         fact about verified pull outcomes, not the absence of them.
import test from "node:test";
import assert from "node:assert/strict";
import { pullsReadyToSettle } from "../server/claim-coordination.mjs";

test("M10: a claim with no pull links is never ready to settle", () => {
  assert.equal(pullsReadyToSettle({}), false, "no pull records at all");
  assert.equal(pullsReadyToSettle({ pullRequests: [] }), false, "an empty link list is not vacuous readiness");
  assert.equal(pullsReadyToSettle({ pullRequest: { url: "https://example.com/pr/1", outcome: "merged" } }), true,
    "a merged link is ready");
  assert.equal(pullsReadyToSettle({ pullRequests: [{ url: "https://example.com/pr/1", outcome: null }] }), false,
    "an outcome still unknown is not ready");
});
