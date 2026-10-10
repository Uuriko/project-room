// PRODUCT-200 reliability — deterministic chaos seed runner.
//
// Runs every seed in seeds.mjs against the real implementation and asserts
// the outcome matches the XFAIL manifest (seed.expect):
//
//   expect "fail" — the seed must FAIL for the intended reason (the bug
//     reproduces on this code). If it unexpectedly PASSES, the fix landed:
//     the test fails loudly so the manifest is flipped to "pass" and the
//     seed becomes a permanent regression guard.
//
//   expect "pass" — the property must HOLD. Any violation is a regression.
//
// This keeps CI green on main while machine-verifying that each encoded
// failure sequence still reproduces. See SEEDS.md for the corpus manifest.
//
// Test-audit gate: each seed names an independent contract (see the
// `finding` field), a credible regression (verified failing on main today),
// and coverage no existing test provides (no existing test replays a stale
// release across rounds, retries a byte-identical update, asserts
// board-write event journaling, or covers the secret-lost redeem retry).
// No production seams: seeds drive the real route handler, AgentInvites,
// and RoomStore through their existing entry points.
import test from "node:test";
import assert from "node:assert/strict";
import { SEEDS } from "./seeds.mjs";

for (const seed of SEEDS) {
  test(`${seed.id}: ${seed.title}`, async () => {
    assert.ok(["pass", "fail"].includes(seed.expect), `seed ${seed.id} has an invalid expect value`);
    const { violated, evidence } = await seed.run();
    if (seed.expect === "fail") {
      assert.equal(violated, true,
        `${seed.id} expected to FAIL (bug present) but the property HELD — the fix landed. ` +
        `Flip expect to "pass" in seeds.mjs and re-verify. Evidence: ${evidence}`);
    } else {
      assert.equal(violated, false,
        `${seed.id} property VIOLATED (regression). Evidence: ${evidence}`);
    }
  });
}
