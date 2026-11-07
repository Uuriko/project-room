// QA200-MUT-04 mutation probes for the claim-renew path (playbook §4d footguns).
//
// RULED (RQ-12, Jill, 2026-10-18 — backlog-ratification-queue.md): A2 + B1.
//   A2: a renew that omits `leaseHours` reuses the claim's CURRENT window
//     duration (leaseExpiresAt − leaseStartAt); the room default governs
//     claim creation only and must not silently reset an existing claim's
//     window on renew. Probe A below is the acceptance test for A2 — it
//     was kept skipped until the ruling and failed against the pre-ruling
//     code (a 6h claim renewed at +2h expired at +26h: the 24h default).
//   B1: extension runs from NOW (the renewed expiry is now + duration),
//     never stacked on the old expiry. Probe B's original skipped test
//     asserted the opposite (extend-from-expiry, B2) and is DELETED as
//     decided-against: stacking renewals would bank unbounded lease and
//     defeat the lease's anti-squatting purpose. The from-now semantics
//     are pinned live by tests/work-claim-renew-probe-b.test.js (MUT-04B)
//     and tests/lease-renewal.test.js ("renewWork starts a fresh lease
//     window from now").
// Probe C: renew of an indefinite (null-lease) claim must 422 — CAUGHT by
//   existing tests ("renewWork refuses ... a leaseless claim ..." and
//   "handler: renew of a leaseless claim is refused"); no new test needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimWork, renewWork } from "../server/work-claims.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-08T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

// Probe A (A2): a heartbeat renew (no progressMessageId, no leaseHours) must
// keep the claim's current window duration — not silently reset it to the
// 24h room default (which both upgraded a 6h claim and truncated a 72h one).
test("MUT-04-A: heartbeat renew without progressMessageId keeps the original lease duration", () => {
  const claimed = claimWork({ id: "wA" }, "quill", { leaseHours: 6, now: T0 });
  assert.equal(claimed.leaseExpiresAt, iso(T0 + 6 * H));
  const renewed = renewWork(claimed, "quill", { now: T0 + 2 * H }); // no progressMessageId, no leaseHours
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 8 * H)); // original 6h duration, not the 24h default
  assert.equal(renewed.leaseStartAt, iso(T0 + 2 * H)); // B1: the fresh window starts from now
});

// A2 after a renew: "the claim's duration" is the CURRENT window's, so a
// second omitted-duration renew keeps the duration an explicit renew set.
test("MUT-04-A2: a later omitted-duration renew reuses the current window, not the original claim term", () => {
  const claimed = claimWork({ id: "wA2" }, "quill", { leaseHours: 6, now: T0 });
  const explicit = renewWork(claimed, "quill", { leaseHours: 2, now: T0 + H }); // window is now 2h
  const renewed = renewWork(explicit, "quill", { now: T0 + 2 * H }); // omitted again
  assert.equal(renewed.leaseExpiresAt, iso(T0 + 4 * H)); // current 2h duration from now
});
