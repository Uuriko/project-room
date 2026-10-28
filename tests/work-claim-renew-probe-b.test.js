// QA200-MUT-04B probe B hardening test (2026-10-08).
//
// Playbook §4d footgun: "renew extends from NOW instead of from the current
// lease expiry (shortening an unexpired lease)". Probed as a mutation
// ("change the new-expiry computation to now + duration instead of expiry
// + duration"), but renewWork ALREADY computes now + duration, so the
// mutation is a no-op the suite cannot catch: NOT-CAUGHT by construction.
//
// The extend-from-now behavior is the shipped, documented design:
// renewWork's docstring says "starts a fresh lease window from now", and
// tests/lease-renewal.test.js pins it ("renewWork starts a fresh lease
// window from now"). This test locks that semantics in as a conscious
// design decision rather than an accident: a renew whose duration is
// SMALLER than the remaining lease SHORTENS the window (the leftover of
// the old lease is discarded).
//
// If the coordinator decides renew should extend from the old expiry,
// this test fails under that semantics patch and must be rewritten —
// that is the point: the change becomes a test-visible, deliberate
// decision instead of a silent footgun.
import test from "node:test";
import assert from "node:assert/strict";
import { claimWork, renewWork } from "../server/work-claims.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-08T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

test("MUT-04B: renew starts a fresh window from now — a smaller renewal duration shortens an unexpired lease (documented behavior)", () => {
  const claimed = claimWork({ id: "wB" }, "quill", { leaseHours: 6, now: T0 }); // expires T0+6h
  const renewed = renewWork(claimed, "quill", { leaseHours: 1, now: T0 + 2 * H }); // +2h in, 4h left
  // Fresh window from now: expiry is T0+3h, NOT T0+7h (old expiry + 1h).
  // The remaining 4h of the old lease are discarded.
  assert.equal(renewed.leaseStartAt, iso(T0 + 2 * H));
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 3 * H));
});
