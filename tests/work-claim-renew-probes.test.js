// QA200-MUT-04 mutation probes for the claim-renew path (playbook §4d footguns).
//
// UN-SKIPPED AND RE-PINNED (T-4, find:work-claim-renew-probes-001): this
// file previously held two test.skip cases, so it pinned nothing in CI.
// The renew SEMANTICS are still undecided — the probes below do not
// decide them. What they pin, live, is the CURRENT behaviour, footguns
// included, with the footgun named at each assertion — the same current
// behaviour tests/lease-renewal.test.js pins ("the room's default 24h",
// "starts a fresh lease window from now"). When the renew semantics are
// decided, flip these assertions and the lease-renewal ones together.
//
// Probe A: renew with NO progressMessageId currently applies the 24h
//   room default (footgun candidate: silently upgrades a 6h lease).
// Probe B: renew currently extends from NOW, not from the old expiry
//   (footgun candidate: extend-from-now steals ~9min on a 15-min lease
//   renewed at +6min).
// Probe C: renew of an indefinite (null-lease) claim must 422 — CAUGHT by
//   existing tests ("renewWork refuses ... a leaseless claim ..." and
//   "handler: renew of a leaseless claim is refused"); no new test needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimWork, renewWork } from "../server/work-claims.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-08T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

// Probe A — CURRENT behaviour pinned: a heartbeat renew (no
// progressMessageId, no leaseHours) applies the 24h room default from
// now. FOOTGUN (undecided): the original 6h duration is NOT kept.
test("MUT-04-A (current behaviour): heartbeat renew without leaseHours applies the 24h room default", () => {
  const claimed = claimWork({ id: "wA" }, "quill", { leaseHours: 6, now: T0 });
  assert.equal(claimed.leaseExpiresAt, iso(T0 + 6 * H));
  const renewed = renewWork(claimed, "quill", { now: T0 + 2 * H }); // no progressMessageId, no leaseHours
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 26 * H),
    "current: renew at +2h with no leaseHours lands at now+24h (the footgun: not the original 6h duration, which would land at +8h)");
});

// Probe B — CURRENT behaviour pinned: renew with an explicit duration
// starts a fresh window from NOW. FOOTGUN (undecided): it does NOT
// stack on the old expiry.
test("MUT-04-B (current behaviour): renew extends from now, not from the old expiry", () => {
  const claimed = claimWork({ id: "wB" }, "quill", { leaseHours: 0.25, now: T0 }); // 15-min lease
  const atRenew = T0 + 6 * 60 * 1000; // +6min
  const renewed = renewWork(claimed, "quill", { leaseHours: 1, now: atRenew });
  assert.equal(renewed.leaseExpiresAt, iso(atRenew + H),
    "current: now+1h (the footgun: old-expiry+1h would be 9 minutes later)");
});
