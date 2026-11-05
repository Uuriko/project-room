// Slot-lock expiry classification (relay/src/lock.mjs).
//
// A work claim's leaseExpiresAt is the only evidence that its slot lease is
// still live. Three readers in this codebase parse claim/lease expiries:
// machine-link's enroll check and auth's liveLease both fail closed on an
// unparseable value; the slot lock must do the same. A present-but-unparseable
// expiry is corrupt evidence, not "no expiry": treating it as no expiry made
// the claim an active slot holder forever and blocked every later claimant.
//
// A null leaseExpiresAt is different: the producer (server/work-claims.mjs)
// issues lease-less claims on purpose and its isLeaseExpired treats a null
// lease as non-expiring, so the lock mirrors that and keeps the claim active.

import assert from "node:assert/strict";
import test from "node:test";
import { holdersForMachine, isActiveWorkClaim } from "../src/lock.mjs";

const NOW = Date.parse("2026-10-31T00:00:00Z");
const MACHINE = "mch_0123456789abcdef";

const claim = (overrides = {}) => ({
  id: "c1",
  kind: "work",
  state: "claimed",
  owner: "mem_a",
  claimedAt: "2026-10-30T00:00:00Z",
  files: [`resource/${MACHINE}/desk`],
  ...overrides,
});

test("a well-formed future lease expiry is active and holds the slot", () => {
  const live = claim({ leaseExpiresAt: "2026-11-01T00:00:00Z" });
  assert.equal(isActiveWorkClaim(live, NOW), true);
  assert.equal(holdersForMachine([live], MACHINE, NOW).get("desk")?.id, "c1");
});

test("a well-formed past lease expiry is inactive and releases the slot", () => {
  const expired = claim({ leaseExpiresAt: "2026-10-01T00:00:00Z" });
  assert.equal(isActiveWorkClaim(expired, NOW), false);
  assert.equal(holdersForMachine([expired], MACHINE, NOW).get("desk"), undefined);
});

test("a present but unparseable lease expiry fails closed", () => {
  for (const leaseExpiresAt of ["garbage", "2026-13-45T99:99:99Z", "", 12345, {}, []]) {
    const corrupt = claim({ leaseExpiresAt });
    assert.equal(isActiveWorkClaim(corrupt, NOW), false, `leaseExpiresAt=${JSON.stringify(leaseExpiresAt)}`);
    assert.equal(holdersForMachine([corrupt], MACHINE, NOW).get("desk"), undefined);
  }
});

test("a corrupt-expiry claim does not block a later legitimate claimant", () => {
  const corrupt = claim({ id: "c_bad", leaseExpiresAt: "garbage" });
  const legit = claim({ id: "c_good", owner: "mem_b", claimedAt: "2026-10-30T01:00:00Z", leaseExpiresAt: "2026-11-01T00:00:00Z" });
  assert.equal(holdersForMachine([corrupt, legit], MACHINE, NOW).get("desk")?.id, "c_good");
});

test("a null lease expiry stays active (lease-less claims are non-expiring by producer design)", () => {
  const leaseless = claim({ leaseExpiresAt: null });
  assert.equal(isActiveWorkClaim(leaseless, NOW), true);
  assert.equal(holdersForMachine([leaseless], MACHINE, NOW).get("desk")?.id, "c1");
});
