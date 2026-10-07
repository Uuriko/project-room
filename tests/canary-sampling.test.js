// Canary sampling simulator tests (200-hard-tasks #23).
// Contract guarded: the sampling math the design doc recommends actually
// catches a cheating provider — at the recommended 5% sampling rate a
// 10%-cheater is caught with p >= 0.99 within 1000 jobs, and honest
// providers are never flagged. Credible regression: a sign error in the
// detection formula (e.g. using s+f instead of s*f) would recommend a
// sampling rate that provably misses cheaters; the simulation cross-checks
// the closed form empirically.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectionProbability,
  jobsForDetection,
  costOverhead,
  recommendRate,
  simulate,
} from "../scripts/simulate-canary.mjs";

describe("canary sampling", () => {
  it("closed form: certainty cases behave", () => {
    assert.equal(detectionProbability({ jobs: 100, sampleRate: 0, cheatRate: 0.5 }), 0);
    assert.equal(detectionProbability({ jobs: 100, sampleRate: 0.5, cheatRate: 0 }), 0);
    assert.ok(detectionProbability({ jobs: 10000, sampleRate: 0.05, cheatRate: 0.5 }) > 0.9999);
  });

  it("rejects invalid rates", () => {
    assert.throws(() => detectionProbability({ jobs: 10, sampleRate: 1.5, cheatRate: 0.1 }), /<= 1/);
    assert.throws(() => detectionProbability({ jobs: 10, sampleRate: 0.1, cheatRate: -0.1 }), />= 0/);
  });

  it("recommends 5% sampling for a 10%-cheater at 1000 jobs (p>=0.99)", () => {
    const rec = recommendRate({ cheatRate: 0.1, detectProb: 0.95, jobs: 1000, target: 0.99 });
    assert.equal(rec.sampleRate, 0.05);
    assert.equal(rec.overhead, 0.1); // 5% sampling at 2x trusted cost = 10% overhead
  });

  it("simulation: 10%-cheater caught with p>=0.99 at the recommended rate", () => {
    const sim = simulate({ jobs: 1000, sampleRate: 0.05, cheatRate: 0.1, detectProb: 0.95, trials: 5000, seed: 7 });
    assert.ok(sim.empiricalDetection >= 0.99, `empirical P=${sim.empiricalDetection}`);
    // Empirical and closed-form agree within 2 points: the math is honest.
    assert.ok(Math.abs(sim.empiricalDetection - sim.closedForm) < 0.02);
  });

  it("simulation: honest providers are never flagged", () => {
    const sim = simulate({ jobs: 1000, sampleRate: 0.05, cheatRate: 0, trials: 2000, seed: 7 });
    assert.equal(sim.empiricalDetection, 0);
  });

  it("jobsForDetection matches the design-doc table", () => {
    assert.equal(jobsForDetection({ sampleRate: 0.05, cheatRate: 0.1, detectProb: 0.95, target: 0.99 }), 968);
    assert.equal(jobsForDetection({ sampleRate: 0.05, cheatRate: 0.05, detectProb: 0.95, target: 0.99 }), 1937);
  });

  it("cost overhead is sampleRate x trustedCostMult", () => {
    assert.equal(costOverhead({ sampleRate: 0.05, trustedCostMult: 2 }), 0.1);
    assert.equal(costOverhead({ sampleRate: 0.01 }), 0.02);
  });
});
