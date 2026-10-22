import test from "node:test";
import assert from "node:assert/strict";
import { fallbackEligibility, FALLBACK_SILENCE_MS } from "../scripts/release-fallback.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const T0 = Date.parse("2026-10-22T05:00:00.000Z");
const base = (over = {}) => ({
  fallback: { memberId: "grok", githubLogin: "grok-bot" },
  approvedFallbacks: ["grok"],
  ask: { head: HEAD, base: BASE, postedAt: new Date(T0).toISOString(), releaseSeatRepliedAt: null },
  pr: { head: HEAD, base: BASE, authorLogin: "jill", state: "open" },
  checks: { status: "green" },
  reads: [{ login: "codex", head: HEAD }],
  holds: [],
  prNumber: 4490,
  nowMs: T0 + FALLBACK_SILENCE_MS,
  ...over,
});

test("eligible after 30 minutes of release-seat silence", () => {
  assert.equal(fallbackEligibility(base()).eligible, true);
});

test("timeout: refused before 30 minutes and after a release-seat reply", () => {
  const early = fallbackEligibility(base({ nowMs: T0 + FALLBACK_SILENCE_MS - 1 }));
  assert.equal(early.reason, "too_soon");
  assert.equal(early.waitMs, 1);
  const replied = base();
  replied.ask.releaseSeatRepliedAt = new Date(T0 + 60000).toISOString();
  assert.equal(fallbackEligibility(replied).reason, "release_seat_replied");
});

test("an active hold on the head or PR blocks the fallback", () => {
  assert.equal(fallbackEligibility(base({ holds: [{ head: HEAD, active: true }] })).reason, "held");
  assert.equal(fallbackEligibility(base({ holds: [{ prNumber: 4490 }] })).reason, "held");
  assert.equal(fallbackEligibility(base({ holds: [{ head: HEAD, active: false }] })).eligible, true);
});

test("a PR authored by the fallback agent is refused", () => {
  assert.equal(fallbackEligibility(base({ pr: { head: HEAD, base: BASE, authorLogin: "grok-bot", state: "open" } })).reason, "self_authored");
  assert.equal(fallbackEligibility(base({ pr: { head: HEAD, base: BASE, authorLogin: "x", authorMemberId: "grok", state: "open" } })).reason, "self_authored");
});

test("a stale head or base is refused", () => {
  const moved = fallbackEligibility(base({ pr: { head: "c".repeat(40), base: BASE, authorLogin: "jill", state: "open" } }));
  assert.equal(moved.reason, "stale_head");
  assert.equal(fallbackEligibility(base({ pr: { head: HEAD, base: "d".repeat(40), authorLogin: "jill", state: "open" } })).reason, "stale_base");
});

test("other gates: unapproved agent, non-green checks, missing or self reads", () => {
  assert.equal(fallbackEligibility(base({ approvedFallbacks: [] })).reason, "not_approved_fallback");
  assert.equal(fallbackEligibility(base({ checks: { status: "incomplete" } })).reason, "checks_not_green");
  assert.equal(fallbackEligibility(base({ reads: [{ login: "codex", head: "e".repeat(40) }] })).reason, "no_non_author_read");
  assert.equal(fallbackEligibility(base({ reads: [{ login: "grok-bot", head: HEAD }] })).reason, "no_non_author_read");
  assert.equal(fallbackEligibility(null).reason, "not_approved_fallback");
});
