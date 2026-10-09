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

// Probe A: a renew with no explicit leaseHours must keep the claim's
// ORIGINAL lease duration — not silently upgrade to the 24h default.
// FIX-11 decided semantics: renew extends from the OLD EXPIRY, so the new
// expiry is old expiry + original duration (T0+6h + 6h = T0+12h).
// (The pure machine does not check progressMessageId — that is the route
// layer's job — so this pure-machine probe needs no progress id.)
test("MUT-04-A: renew without leaseHours keeps the original lease duration, extended from the old expiry", () => {
  const claimed = claimWork({ id: "wA" }, "quill", { leaseHours: 6, now: T0 });
  assert.equal(claimed.leaseExpiresAt, iso(T0 + 6 * H));
  const renewed = renewWork(claimed, "quill", { now: T0 + 2 * H }); // no progressMessageId, no leaseHours
  assert.equal(renewed.leaseStartAt, iso(T0 + 6 * H)); // window slides to the old expiry
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 12 * H)); // old expiry + original 6h, not the 24h default
});

// Probe B: renew with an explicit duration must stack on the OLD expiry,
// not restart the window from now.
// FIX-11 decided semantics (2026-10-09): extend from the old expiry.
test("MUT-04-B: renew extends from the old expiry, not from now", () => {
  const claimed = claimWork({ id: "wB" }, "quill", { leaseHours: 0.25, now: T0 }); // 15-min lease
  const atRenew = T0 + 6 * 60 * 1000; // +6min
  const renewed = renewWork(claimed, "quill", { leaseHours: 1, now: atRenew });
  assert.equal(renewed.leaseStartAt, iso(T0 + 15 * 60 * 1000)); // window slides to the old expiry
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 15 * 60 * 1000 + H)); // old expiry + 1h, not now + 1h
});
