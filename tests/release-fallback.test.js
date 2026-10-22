import test from "node:test";
import assert from "node:assert/strict";
import { APPROVED_FALLBACKS, fallbackEligibility, FALLBACK_SILENCE_MS } from "../scripts/release-fallback.mjs";

const JILL = "ai_rNH_kQLusyE2Y0sj";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const T0 = Date.parse("2026-10-22T05:00:00.000Z");
const NOW = T0 + FALLBACK_SILENCE_MS;
const iso = ms => new Date(ms).toISOString();
const base = (over = {}) => ({
  fallback: { memberId: JILL, githubLogin: "jill-2" },
  ask: { head: HEAD, base: BASE, postedAt: iso(T0), releaseSeatRepliedAt: null },
  pr: { number: 4490, head: HEAD, base: BASE, authorLogin: "codex-bot", state: "open" },
  checks: { head: HEAD, status: "green", includesCommitStatuses: true },
  reads: [{ login: "codex", head: HEAD, verified: true }],
  holdObservation: { prNumber: 4490, head: HEAD, observedAt: iso(NOW - 1000), complete: true, holds: [] },
  nowMs: NOW,
  ...over,
});
const pr = over => ({ number: 4490, head: HEAD, base: BASE, authorLogin: "codex-bot", state: "open", ...over });

test("eligible after 30 minutes of release-seat silence", () => {
  assert.equal(fallbackEligibility(base()).eligible, true);
});

test("timeout: too soon, a release-seat reply, NaN or future times all refuse", () => {
  const early = fallbackEligibility(base({ nowMs: NOW - 1 }));
  assert.equal(early.reason, "too_soon");
  assert.equal(early.waitMs, 1);
  const replied = base();
  replied.ask.releaseSeatRepliedAt = iso(T0 + 60000);
  assert.equal(fallbackEligibility(replied).reason, "release_seat_replied");
  assert.equal(fallbackEligibility(base({ nowMs: Number.NaN })).reason, "invalid_time");
  const future = base();
  future.ask.postedAt = iso(NOW + 1);
  assert.equal(fallbackEligibility(future).reason, "invalid_time");
});

test("holds: an active hold blocks; a missing, partial, stale or unbound observation refuses", () => {
  const held = obs => base({ holdObservation: { prNumber: 4490, head: HEAD, observedAt: iso(NOW - 1000), complete: true, ...obs } });
  assert.equal(fallbackEligibility(held({ holds: [{ head: HEAD, active: true }] })).reason, "held");
  assert.equal(fallbackEligibility(held({ holds: [{ prNumber: 4490 }] })).reason, "held");
  assert.equal(fallbackEligibility(held({ holds: [{ head: HEAD, active: false }] })).eligible, true);
  assert.equal(fallbackEligibility(base({ holdObservation: undefined })).reason, "holds_unobserved");
  assert.equal(fallbackEligibility(held({ holds: [], complete: false })).reason, "holds_unobserved");
  assert.equal(fallbackEligibility(held({ holds: [], head: "c".repeat(40) })).reason, "holds_unobserved");
  assert.equal(fallbackEligibility(held({ holds: [], observedAt: iso(NOW - 6 * 60 * 1000) })).reason, "holds_unobserved");
});

test("self-authored or unknown-author PRs are refused", () => {
  assert.equal(fallbackEligibility(base({ pr: pr({ authorLogin: "jill-2" }) })).reason, "self_authored");
  assert.equal(fallbackEligibility(base({ pr: pr({ authorLogin: "x", authorMemberId: JILL }) })).reason, "self_authored");
  assert.equal(fallbackEligibility(base({ pr: pr({ authorLogin: undefined }) })).reason, "author_unknown");
});

test("a stale head or base is refused, and checks must be bound to the head", () => {
  assert.equal(fallbackEligibility(base({ pr: pr({ head: "c".repeat(40) }) })).reason, "stale_head");
  assert.equal(fallbackEligibility(base({ pr: pr({ base: "d".repeat(40) }) })).reason, "stale_base");
  assert.equal(fallbackEligibility(base({ checks: { head: "c".repeat(40), status: "green", includesCommitStatuses: true } })).reason, "checks_unbound");
  assert.equal(fallbackEligibility(base({ checks: { head: HEAD, status: "green" } })).reason, "checks_incomplete");
  assert.equal(fallbackEligibility(base({ checks: { head: HEAD, status: "incomplete", includesCommitStatuses: true } })).reason, "checks_not_green");
});

test("reads must be verified, non-author, and at the head", () => {
  assert.equal(fallbackEligibility(base({ reads: [{ login: "codex", head: HEAD }] })).reason, "no_non_author_read");
  assert.equal(fallbackEligibility(base({ reads: [{ login: "codex", head: "e".repeat(40), verified: true }] })).reason, "no_non_author_read");
  assert.equal(fallbackEligibility(base({ reads: [{ login: "jill-2", head: HEAD, verified: true }] })).reason, "no_non_author_read");
  assert.equal(fallbackEligibility(base({ reads: undefined })).reason, "no_non_author_read");
});

test("the owner-approved fallback list names Jill 2 only", () => {
  assert.deepEqual([...APPROVED_FALLBACKS], [JILL]);
  assert.equal(fallbackEligibility(base({ fallback: { memberId: "ai_NiIvggYi1S2wfYN_", githubLogin: "grok-bot" } })).reason, "not_approved_fallback");
  assert.equal(fallbackEligibility(base({ approvedFallbacks: [] })).reason, "not_approved_fallback");
  assert.equal(fallbackEligibility(null).reason, "not_approved_fallback");
});
