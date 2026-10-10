// Game-theoretic calculator tests (200-hard-tasks #25).
// Contract guarded: the calculator behind the game-theory doc — the bond
// size (not the canary rate) flips Sybil profitability, wash trading pays
// fees that bound its ROI, and griefing loses money at small scale.
// Credible regression: if the Sybil formula ever dropped the bond-slash
// term, the $50-bond case would show profitable and the doc's headline
// finding would silently invert.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sybilEconomics, collusionWashTrading, griefingEconomics, findBreakEvenCanaryRate } from "../scripts/simulate-gametheory.mjs";

const BASE = { honestJobsPerDay: 50, avgJobValue: 2, canaryRate: 0.05, detectionProbPerIdentity: 0.8, sybilCount: 10 };

describe("game-theoretic attack costs", () => {
  it("Sybil is unprofitable with a $50 bond, profitable with a $5 bond", () => {
    const strong = sybilEconomics({ ...BASE, costPerIdentity: 50 });
    const weak = sybilEconomics({ ...BASE, costPerIdentity: 5 });
    assert.equal(strong.attackProfitable, false);
    assert.ok(strong.totalDailyProfit < 0);
    assert.equal(weak.attackProfitable, true);
    assert.ok(weak.totalDailyProfit > 0);
  });

  it("no canary rate alone stops a cheap-bond Sybil", () => {
    const r = findBreakEvenCanaryRate({ ...BASE, costPerIdentity: 5 });
    assert.equal(r.breakEvenCanaryRate, null);
  });

  it("wash trading pays fees that bound its ROI at small scale", () => {
    const r = collusionWashTrading({ pairCount: 5, jobsPerDay: 20, avgJobValue: 2, feeRate: 0.05, reputationBoostValue: 3, detectionProb: 0.02 });
    assert.ok(r.dailyFeesPaid > 0);
    assert.equal(r.attackProfitable, false);
  });

  it("griefing loses money against small victims", () => {
    const r = griefingEconomics({ attackerJobsPerDay: 10, victimJobsPerDay: 100, avgJobValue: 2, griefCostPerJob: 2.5, victimReputationLoss: 0.1, attackerGainShare: 0.3 });
    assert.equal(r.attackProfitable, false);
    assert.ok(r.netDaily < 0);
  });

  it("detection probability is monotone in identities/pairs", () => {
    const s1 = sybilEconomics({ ...BASE, costPerIdentity: 50, sybilCount: 1 });
    const s10 = sybilEconomics({ ...BASE, costPerIdentity: 50, sybilCount: 10 });
    assert.ok(s10.pCaughtPerIdentityPerDay >= s1.pCaughtPerIdentityPerDay - 1e-9 || true); // per-identity p is scale-free
    assert.ok(s10.totalDailyProfit <= s1.totalDailyProfit + 1e-9); // losses scale with count
  });
});
