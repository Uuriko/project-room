// CCTP v2 funding simulator tests (200-hard-tasks #8).
// Contract guarded: the mocked cross-chain funding flow — quote, burn,
// attestation polling, mint, hook execution with escrow metadata —
// completes for both fast and standard modes with the documented timing
// asymmetry, and every failure in the failure table is reachable and
// classified. Credible regression: if the hook ever executed without the
// envelope metadata, the minted funds could not be routed to the escrow;
// the hook-metadata assertion pins the binding.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTransfer, pollWithRetry, quote, DOMAINS } from "../scripts/simulate-cctp.mjs";

describe("cctp funding simulator", () => {
  it("quotes fast vs standard with the fee/timing asymmetry", () => {
    const fast = quote({ amountRaw: "1000000", mode: "fast" });
    const std = quote({ amountRaw: "1000000", mode: "standard" });
    assert.equal(fast.feeRaw, "1000"); // 10 bps
    assert.equal(std.feeRaw, "100"); // 1 bp
    assert.equal(fast.netRaw, "999000");
    assert.ok(fast.etaSec.max < std.etaSec.min, "fast must settle before standard starts");
    assert.equal(fast.sourceDomain, DOMAINS.solana);
    assert.equal(fast.destDomain, DOMAINS.monad);
    assert.throws(() => quote({ amountRaw: "1000000", mode: "teleport" }), /unknown mode/);
    assert.throws(() => quote({ amountRaw: "0", mode: "fast" }), /> 0/);
  });

  it("fast transfer completes in seconds with hook metadata", () => {
    const t = createTransfer({ transferId: "t-fast", jobId: "job-1", envelopeId: "env_1", amountRaw: "1000000", mode: "fast", seed: 7 });
    const done = t.runToCompletion({ pollIntervalSec: 1 });
    assert.equal(done.status, "minted");
    assert.ok(done.nowSec <= 4, `fast took ${done.nowSec}s`);
    assert.equal(done.hookExecuted, true);
    assert.deepEqual(done.hookMetadata, {
      hook: "funding-escrow",
      jobId: "job-1",
      envelopeId: "env_1",
      expectedNetRaw: "999000",
      asset: "USDC",
    });
  });

  it("standard transfer completes in minutes (attestation finality)", () => {
    const t = createTransfer({ transferId: "t-std", jobId: "job-2", envelopeId: "env_2", amountRaw: "1000000", mode: "standard", seed: 7 });
    const done = t.runToCompletion({ pollIntervalSec: 30 });
    assert.equal(done.status, "minted");
    assert.ok(done.nowSec >= 600 && done.nowSec <= 1200, `standard took ${done.nowSec}s`);
    assert.equal(done.polls, Math.ceil(done.nowSec / 30));
  });

  it("re-polling a minted transfer is a replay, not a second mint", () => {
    const t = createTransfer({ transferId: "t-re", jobId: "job-3", envelopeId: "env_3", amountRaw: "1000000", mode: "fast", seed: 7 });
    const done = t.runToCompletion({ pollIntervalSec: 1 });
    assert.equal(done.status, "minted");
    const again = t.poll({ pollIntervalSec: 1 });
    assert.equal(again.replayed, true);
    assert.equal(again.status, "minted");
  });

  it("failure table: attestation timeout is classified", () => {
    const t = createTransfer({ transferId: "t-to", jobId: "job-4", envelopeId: "env_4", amountRaw: "1000000", mode: "standard", seed: 7, faults: { attestationTimeoutAt: 100 } });
    const done = t.runToCompletion({ pollIntervalSec: 30 });
    assert.equal(done.status, "failed");
    assert.equal(done.error, "attestation-timeout");
  });

  it("failure table: hook revert is classified", () => {
    const t = createTransfer({ transferId: "t-hr", jobId: "job-5", envelopeId: "env_5", amountRaw: "1000000", mode: "fast", seed: 7, faults: { hookReverts: true } });
    const done = t.runToCompletion({ pollIntervalSec: 1 });
    assert.equal(done.status, "failed");
    assert.equal(done.error, "hook-reverted");
    assert.equal(done.hookExecuted, false);
  });

  it("failure table: insufficient fee is classified", () => {
    const t = createTransfer({ transferId: "t-if", jobId: "job-6", envelopeId: "env_6", amountRaw: "1000000", mode: "fast", seed: 7, faults: { insufficientFee: true } });
    const done = t.runToCompletion({ pollIntervalSec: 1 });
    assert.equal(done.status, "failed");
    assert.equal(done.error, "insufficient-fee");
  });

  it("failure table: never-attested transfer hits the poller timeout", () => {
    const t = createTransfer({ transferId: "t-na", jobId: "job-7", envelopeId: "env_7", amountRaw: "1000000", mode: "standard", seed: 7, faults: { neverAttests: true } });
    const done = t.runToCompletion({ pollIntervalSec: 600, timeoutSec: 3600 });
    assert.equal(done.status, "failed");
    assert.equal(done.error, "poller-timeout");
  });

  it("pollWithRetry recovers from a transient attestation timeout", () => {
    const t = createTransfer({ transferId: "t-rt", jobId: "job-8", envelopeId: "env_8", amountRaw: "1000000", mode: "fast", seed: 7, faults: { attestationTimeoutAt: 2 } });
    const done = pollWithRetry(t, { maxAttempts: 5, baseIntervalSec: 1 });
    assert.equal(done.status, "minted");
    assert.ok(done.attempts >= 1);
  });
});
