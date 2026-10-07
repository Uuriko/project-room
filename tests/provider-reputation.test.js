// Provider reputation tests (200-hard-tasks #24).
// Contract guarded: the scoring formula separates honest, flaky and
// malicious providers into the right order and tiers over 1000 simulated
// jobs, disputes count won+lost in the total (a lost-only total collapses
// the dispute rate to ~0 for everyone), and recent behavior outweighs old
// behavior via decay. Credible regression: counting only lost disputes in
// the total makes disputeRate -> 0 for every disputing provider, honest or
// not, which these trajectory assertions catch.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReputation, simulateProvider, routingTier } from "../scripts/simulate-reputation.mjs";

describe("provider reputation", () => {
  it("starts new providers at 1.0 (optimistic)", () => {
    assert.equal(createReputation().score(), 1);
  });

  it("trajectories order honest > flaky > malicious over 1000 jobs", () => {
    const honest = simulateProvider("honest", { jobs: 1000, seed: 11 });
    const flaky = simulateProvider("flaky", { jobs: 1000, seed: 11 });
    const malicious = simulateProvider("malicious", { jobs: 1000, seed: 11 });
    assert.ok(honest.finalScore > 0.95, `honest=${honest.finalScore}`);
    assert.ok(flaky.finalScore > malicious.finalScore, `flaky=${flaky.finalScore} malicious=${malicious.finalScore}`);
    assert.ok(malicious.finalScore < 0.8, `malicious=${malicious.finalScore}`);
    assert.equal(routingTier(honest.finalScore), "preferred");
    assert.equal(routingTier(malicious.finalScore), "probation");
  });

  it("routing tiers have the documented boundaries", () => {
    assert.equal(routingTier(0.95), "preferred");
    assert.equal(routingTier(0.9), "preferred");
    assert.equal(routingTier(0.8), "standard");
    assert.equal(routingTier(0.75), "standard");
    assert.equal(routingTier(0.6), "probation");
    assert.equal(routingTier(0.55), "probation");
    assert.equal(routingTier(0.54), "suspended");
    assert.equal(routingTier(0), "suspended");
  });

  it("disputesTotal counts won disputes too (lost-only accounting collapses the rate)", () => {
    const rep = createReputation();
    // 10 disputes, provider wins 9, loses 1: disputeRate should be ~0.9, not ~0.
    for (let i = 0; i < 9; i++) rep.observe({ dispute: "won" });
    rep.observe({ dispute: "lost" });
    const { disputeRate } = rep.components();
    assert.ok(disputeRate > 0.5, `disputeRate=${disputeRate} — won disputes are missing from the total`);
  });

  it("a lost dispute hurts more than a won dispute", () => {
    const a = createReputation();
    a.observe({ dispute: "won" });
    const b = createReputation();
    b.observe({ dispute: "lost" });
    assert.ok(b.score() < a.score());
  });

  it("decay lets a reformed provider recover", () => {
    const rep = createReputation();
    for (let i = 0; i < 50; i++) rep.observe({ canary: false, success: false, latencyMs: 20000 });
    const bad = rep.score();
    assert.ok(bad < 0.6, `bad=${bad}`);
    for (let i = 0; i < 400; i++) rep.observe({ canary: true, success: true, latencyMs: 1000 });
    assert.ok(rep.score() > bad + 0.2, `recovered=${rep.score()} from ${bad}`);
  });

  it("cheating is punished superlinearly (convex canary term)", () => {
    const steady = createReputation();
    for (let i = 0; i < 300; i++) steady.observe({ canary: i % 10 < 7, latencyMs: 1000, success: true });
    // 30% canary fail rate with perfect latency/uptime must not stay "standard".
    assert.ok(steady.score() < 0.75, `score=${steady.score()} — cheating hides behind good latency`);
  });

  it("rejects unknown archetypes", () => {
    assert.throws(() => simulateProvider("saint", {}), /unknown archetype/);
  });
});
