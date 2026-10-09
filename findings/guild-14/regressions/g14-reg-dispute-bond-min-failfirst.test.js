// Guild-14 fail-first repro (NOT in tests/ — it FAILS on the current code by
// design). Bug: server/bounty-disputes.mjs:116
//   const minimum = Math.max(1, Math.floor(bountyAmount * MIN_BOND_RATIO));
// The module's own comment says "open bond = max($1, 5% of bounty)", but
// Math.floor lets the minimum slip UNDER 5% by up to just under 1 unit:
// bountyAmount=21 -> 5% = 1.05 -> floor -> minimum=1, and 1/21 = 4.76% < 5%.
// A bond strictly below 5% of the bounty must be rejected; the minimum must
// use Math.ceil. Fix: minimum = Math.max(1, Math.ceil(bountyAmount * MIN_BOND_RATIO)).
// This test PASSES after that one-word fix, FAILS now.
// Found via survived mutant m4-bond-min-ceil (2026-10-09).
import test from "node:test";
import assert from "node:assert/strict";
import { createDisputes } from "../../../server/bounty-disputes.mjs";

test("g14-failfirst: bond below 5% of bounty is rejected", () => {
  const { open } = createDisputes({});
  assert.throws(() => open({ disputeId: "d1", bountyId: "b1", bountyAmount: 21, raisedBy: "x", reason: "r", bond: 1 }),
    /at least 1\.05|bond must be at least/, "bond of 1 on a 21-unit bounty (4.76%) was accepted");
  // 5% exactly (rounded up) is still accepted.
  const d = open({ disputeId: "d2", bountyId: "b2", bountyAmount: 21, raisedBy: "x", reason: "r", bond: 2 });
  assert.equal(d.bondSnapshot, 2);
});
