// Provider cost model tests (200-hard-tasks #28).
// Contract guarded: the unit-economics model — margin arithmetic,
// the dominance ranking (revenue/utilization/hardware over electricity),
// and the finding that orchestration overhead is economically negligible.
// Credible regression: if the throughput derate ever double-counted
// overhead, the jobs/month figure would collapse and the ranking would
// invert; the dominance assertions pin the model's conclusions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sensitivityAnalysis, toCsv } from "../scripts/provider-cost-model.mjs";

describe("provider cost model", () => {
  it("base case: positive margin at 2x$49 revenue", () => {
    const a = sensitivityAnalysis();
    assert.ok(a.base.margin > 0, `margin ${a.base.margin} not positive`);
    assert.ok(a.base.jobsPerMonth > 10000, "throughput implausibly low");
    assert.ok(a.base.costPerJob < 0.01, `cost/job $${a.base.costPerJob} too high`);
  });

  it("margin is dominated by revenue, utilization, hardware — not electricity", () => {
    const a = sensitivityAnalysis();
    const top3 = a.ranked.slice(0, 3).map(([input]) => input);
    assert.ok(top3.includes("revenue ($/mo)"), `top3 ${top3} missing revenue`);
    assert.ok(top3.includes("serving hours/day"), `top3 ${top3} missing utilization`);
    const elec = a.ranked.find(([input]) => input === "electricity (wall power W)");
    const hw = a.ranked.find(([input]) => input === "hardware amortization ($/h)");
    assert.ok(elec[1] < hw[1], "electricity should matter less than hardware amortization");
  });

  it("orchestration overhead is economically negligible", () => {
    const a = sensitivityAnalysis();
    const oh = a.rankedCostPerJob.find(([input]) => input === "orchestration overhead (ms/job)");
    assert.ok(oh[1] < 1, `overhead moves cost/job by ${oh[1]}% — expected <1%`);
  });

  it("throughput dominates cost/job", () => {
    const a = sensitivityAnalysis();
    assert.equal(a.rankedCostPerJob[0][0], "throughput (tok/s)");
  });

  it("CSV output has the sensitivity rows and both rankings", () => {
    const a = sensitivityAnalysis();
    const csv = toCsv(a);
    assert.match(csv, /input,change,margin_usd/);
    assert.match(csv, /rank,input,max_abs_margin_delta_usd/);
    assert.match(csv, /rank,input,max_abs_cost_per_job_delta_pct/);
    assert.ok(csv.split("\n").length > 20);
  });
});
