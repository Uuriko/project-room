// Demand-side job-flow simulator tests (200-hard-tasks #30).
// Contract guarded: the queueing simulator finds the saturation knee where
// waits blow up, utilization never exceeds 100%, and the clearing-price
// search returns a price whose demand the fleet serves within SLO.
// Credible regression: an event-ordering bug (serving jobs before advancing
// the clock) would show zero waits at 100% offered load; the knee
// assertions catch it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { simulate, findSaturation, clearingPrice, demandAtPrice } from "../scripts/simulate-demand-flow.mjs";

const SERVICE = { kind: "exponential", mean: 20 };

describe("demand flow simulator", () => {
  it("serves light load with ~zero wait", () => {
    const r = simulate({
      providers: 4,
      arrival: { kind: "exponential", mean: 20 }, // lambda 0.05, offered load 25%
      service: SERVICE,
      durationSec: 3600,
      seed: 1,
    });
    assert.equal(r.abandoned, 0);
    assert.ok(r.p95WaitSec < 5, `p95=${r.p95WaitSec}`);
    assert.ok(r.utilization < 0.5, `util=${r.utilization}`);
  });

  it("shows the queueing cliff at 100% offered load", () => {
    const r = simulate({
      providers: 4,
      arrival: { kind: "exponential", mean: 5 }, // lambda 0.2 = exactly capacity
      service: SERVICE,
      durationSec: 3600,
      seed: 1,
    });
    assert.ok(r.p95WaitSec > 100, `p95=${r.p95WaitSec} — no cliff, event ordering suspect`);
    assert.ok(r.utilization <= 1, `util=${r.utilization} exceeds 100%`);
  });

  it("findSaturation locates the knee below theoretical capacity", () => {
    const { knee, cleanLambda, breachLambda } = findSaturation({ providers: 4, service: SERVICE, sloSec: 30, durationSec: 1800, seed: 1 });
    assert.ok(knee !== null, "no saturation knee found");
    assert.ok(knee < 0.2, `knee=${knee} at or above theoretical capacity 0.2 — SLO breach not detected`);
    assert.ok(cleanLambda < knee && knee <= breachLambda, `bisection inconsistent: ${cleanLambda} < ${knee} <= ${breachLambda}`);
    // The clean side of the knee is SLO-clean on a fresh seed.
    const clean = simulate({
      providers: 4,
      arrival: { kind: "exponential", mean: 1 / cleanLambda },
      service: SERVICE,
      durationSec: 1800,
      seed: 999,
      maxQueueWaitSec: 600,
    });
    assert.ok(clean.p95WaitSec <= 45, `p95=${clean.p95WaitSec} on the clean side of the knee`);
  });

  it("demandAtPrice follows the isoelastic curve", () => {
    const d = { baseLambda: 2.0, basePrice: 0.05, elasticity: 1.5 };
    assert.equal(demandAtPrice({ ...d, price: 0.05 }), 2.0);
    assert.ok(demandAtPrice({ ...d, price: 0.1 }) < 1.0);
    assert.ok(demandAtPrice({ ...d, price: 0.5 }) < demandAtPrice({ ...d, price: 0.2 }));
    assert.throws(() => demandAtPrice({ ...d, price: 0 }), /> 0/);
  });

  it("clearingPrice returns a price the fleet serves within SLO", () => {
    const { price, lambdaAtPrice } = clearingPrice({
      providers: 4,
      service: SERVICE,
      demand: { baseLambda: 2.0, basePrice: 0.05, elasticity: 1.5 },
      sloSec: 30,
      seed: 1,
    });
    assert.ok(price > 0.05, `price=${price} should exceed the $0.05 base under excess demand`);
    const check = simulate({
      providers: 4,
      arrival: { kind: "exponential", mean: 1 / lambdaAtPrice },
      service: SERVICE,
      durationSec: 1800,
      seed: 2, // different seed: the price must clear robustly, not just on seed 1
      maxQueueWaitSec: 600,
    });
    assert.ok(check.p95WaitSec <= 45, `p95=${check.p95WaitSec} at clearing price on a fresh seed`);
  });

  it("impatient jobs abandon instead of waiting forever", () => {
    const r = simulate({
      providers: 1,
      arrival: { kind: "exponential", mean: 5 },
      service: SERVICE,
      durationSec: 600,
      seed: 1,
      maxQueueWaitSec: 60,
    });
    assert.ok(r.abandoned > 0, "no abandonment under extreme overload");
  });

  it("rejects invalid configuration", () => {
    assert.throws(() => simulate({ providers: 0, arrival: { kind: "exponential", mean: 1 }, service: SERVICE, durationSec: 10 }), />= 1/);
    assert.throws(() => simulate({ providers: 1, arrival: { kind: "weird", mean: 1 }, service: SERVICE, durationSec: 10 }), /unknown distribution/);
  });
});
