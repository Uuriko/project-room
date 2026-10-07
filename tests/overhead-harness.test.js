// Orchestration overhead harness tests (200-hard-tasks #29).
// Contract guarded: the harness measures per-stage latencies at multiple
// concurrencies and identifies the top-3 overhead sources by mean
// contribution. Small job counts keep the suite fast; the full 200-job
// sweep numbers live in research/ORCHESTRATION-OVERHEAD-REPORT.md.
// Credible regression: if a stage ever stopped being timed (e.g. a refactor
// dropping the meter measurement), the stage-presence assertion fails.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { measureOverhead, summarize, sweep } from "../scripts/measure-overhead.mjs";

const STAGES = ["queue", "route", "authorize", "meter", "sign", "dispatch"];

describe("overhead harness", () => {
  it("measures every stage for every job", async () => {
    const run = await measureOverhead({ jobs: 10, concurrency: 2, seed: 3 });
    assert.equal(run.records.length, 10);
    for (const r of run.records) {
      for (const s of STAGES) {
        assert.ok(typeof r[s] === "number" && r[s] >= 0, `stage ${s} missing or negative`);
      }
      assert.ok(r.total >= 0);
    }
  });

  it("summarize reports p50/p99 per stage and a top-3", async () => {
    const run = await measureOverhead({ jobs: 20, concurrency: 4, seed: 3 });
    const s = summarize(run);
    assert.equal(s.jobs, 20);
    assert.equal(s.concurrency, 4);
    for (const stage of [...STAGES, "total"]) {
      const v = s.stages[stage];
      assert.ok(v.p99 >= v.p50, `${stage}: p99 < p50`);
      assert.ok(v.mean >= 0, `${stage}: negative mean`);
    }
    assert.equal(s.top3.length, 3);
    const shares = s.top3.reduce((a, t) => a + parseFloat(t.share), 0);
    assert.ok(shares > 0 && shares <= 100.1, `top-3 shares sum to ${shares}%`);
    // top-3 is ordered by mean contribution, descending
    assert.ok(s.top3[0].meanMs >= s.top3[1].meanMs && s.top3[1].meanMs >= s.top3[2].meanMs);
  });

  it("metering uses the real tokenizer (non-trivial prompt takes measurable time)", async () => {
    const run = await measureOverhead({ jobs: 5, concurrency: 1, seed: 3, prompt: "word ".repeat(2000) });
    const s = summarize(run);
    assert.ok(s.stages.meter.mean > 0, "meter stage recorded zero time");
  });

  it("higher concurrency finishes the same work faster (wall clock)", async () => {
    const serial = await measureOverhead({ jobs: 20, concurrency: 1, seed: 3 });
    const parallel = await measureOverhead({ jobs: 20, concurrency: 10, seed: 3 });
    assert.ok(parallel.wallMs < serial.wallMs, `parallel ${parallel.wallMs}ms not faster than serial ${serial.wallMs}ms`);
  });

  it("sweep covers each requested concurrency", async () => {
    const out = await sweep([1, 5], { jobs: 10, seed: 3 });
    assert.deepEqual(out.map((s) => s.concurrency), [1, 5]);
  });
});
