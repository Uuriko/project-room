// QA200-MUT-04 mutation probes for the claim-renew path (playbook §4d footguns).
// Probe A: renew with NO progressMessageId must keep the claim's ORIGINAL
//   lease duration (footgun: silently upgrades to the 24h room default).
// Probe B: renew must extend from the OLD expiry, not from now
//   (footgun: extend-from-now steals ~9min on a 15-min lease renewed at +6min).
// Probe C: renew of an indefinite (null-lease) claim must 422 — CAUGHT by
//   existing tests ("renewWork refuses ... a leaseless claim ..." and
//   "handler: renew of a leaseless claim is refused"); no new test needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimWork, renewWork } from "../server/work-claims.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-08T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

// Probe A: a heartbeat renew (no progressMessageId, no leaseHours) must keep
// the original lease duration — not silently upgrade to the 24h default.
// NOTE (2026-10-08): this test FAILS on current code — the footgun is live.
// renewWork currently applies the room default (24h) when leaseHours is
// omitted, and tests/lease-renewal.test.js pins that ("the room's default 24h").
// Kept skipped until the renew semantics are decided.
test.skip("MUT-04-A: heartbeat renew without progressMessageId keeps the original lease duration", () => {
  const claimed = claimWork({ id: "wA" }, "quill", { leaseHours: 6, now: T0 });
  assert.equal(claimed.leaseExpiresAt, iso(T0 + 6 * H));
  const renewed = renewWork(claimed, "quill", { now: T0 + 2 * H }); // no progressMessageId, no leaseHours
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 8 * H)); // original 6h duration, not the 24h default
});

// Probe B: renew with an explicit duration must stack on the OLD expiry,
// not restart the window from now.
// NOTE (2026-10-08): this test FAILS on current code — the footgun is live.
// renewWork currently computes now+duration, and tests/lease-renewal.test.js
// pins that ("starts a fresh lease window from now").
// Kept skipped until the renew semantics are decided.
test.skip("MUT-04-B: renew extends from the old expiry, not from now", () => {
  const claimed = claimWork({ id: "wB" }, "quill", { leaseHours: 0.25, now: T0 }); // 15-min lease
  const atRenew = T0 + 6 * 60 * 1000; // +6min
  const renewed = renewWork(claimed, "quill", { leaseHours: 1, now: atRenew });
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 15 * 60 * 1000 + H)); // old expiry + 1h, not now + 1h
});
