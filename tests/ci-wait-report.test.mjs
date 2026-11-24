import assert from "node:assert/strict";
import test from "node:test";
import { summarize, traceRun, workflowJobs } from "../scripts/ci-wait-report.mjs";

const at = seconds => new Date(seconds * 1000).toISOString();
const job = (id, name, start, end, extra = {}) => ({
  id, name, started_at: at(start), completed_at: at(end), conclusion: "success", ...extra,
});
const graph = workflowJobs({
  setup: {},
  shards: { name: "shard ${{ matrix.number }}", needs: "setup" },
  optional: {},
  verdict: { name: "${{ inputs.label || 'verdict' }}", needs: ["setup", "shards", "optional"] },
});
const run = { id: 1, created_at: at(0), conclusion: "success", jobs: [
  job(1, "setup", 1, 4),
  job(2, "shard 1", 5, 10),
  job(3, "shard 2", 6, 16, { created_at: at(2), steps: [
    job(11, "Install browser", 6, 8),
    job(12, "Test", 8, 14),
    job(13, "Post actions/cache", 13, 16),
  ] }),
  job(4, "optional", 0, 0, { conclusion: "skipped" }),
  job(5, "verdict", 19, 20, { created_at: at(17) }),
] };

test("traces timed dependencies across the slowest matrix leg and ignores observed skips", () => {
  const value = traceRun(run, { graph, terminal: "verdict", required: ["shard 2"] });
  assert.deepEqual(value.path.map(j => j.name), ["setup", "shard 2", "verdict"]);
  assert.equal(value.wallSeconds, 20);
  assert.equal(value.runnerSecondsAllAttempts, 19);
  assert.equal(value.graph, "observed_dependencies");
  assert.deepEqual(value.phases, { setup: 2, execution: 6, cleanup: 2, observedJobStartDelay: 4, unattributed: 6 });
  assert.equal(value.jobsWithNoCreationTime, 1);
});

test("keeps canceled runs and earlier attempts in separate denominators", () => {
  const retry = { ...run, id: 3, run_attempt: 2, conclusion: "failure", jobs: [
    ...run.jobs, job(17, "verdict", 50, 55, { run_attempt: 2 }),
  ] };
  const result = summarize([run, { id: 2, conclusion: "cancelled", jobs: [] }, retry], { terminal: "verdict" }, () => graph);
  assert.deepEqual(result.outcomes, { cancelled: 1, failure: 1, success: 1 });
  assert.equal(result.unobserved, 1);
  assert.equal(result.successful.medianWallSeconds, 20);
  assert.equal(result.runnerSecondsPriorAttempts, 19);
  assert.equal(result.runnerSecondsWithoutSuccessfulConclusion, 24);
  assert.equal(result.runs[1].graph, "terminal_job_only");
  assert.equal(traceRun(run, { required: ["unavailable"] }), null);
});
