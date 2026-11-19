import test from "node:test";
import assert from "node:assert/strict";
import {
  gradeJobs, gradeMarkdown, jobIdOfName, loadManifest, manifestHash,
  parseManifest, resultOf, resultsFromEnv, worstConclusion,
} from "../scripts/ci-verdict.mjs";

const manifest = loadManifest();
const ALL_PASS = Object.fromEntries(manifest.jobs.map(job => [job.job_id, "success"]));

test("manifest parses, validates the closed schema, and hashes stably", () => {
  assert.equal(manifest.workflow, "test");
  assert.ok(manifest.jobs.length >= 10);
  assert.equal(manifestHash(manifest), manifestHash(parseManifest(JSON.stringify(manifest))));
  assert.throws(() => parseManifest({ workflow: "test", jobs: [{ job_id: "x" }] }), /exactly the fields/);
  assert.throws(() => parseManifest({
    workflow: "test",
    jobs: [...manifest.jobs, { ...manifest.jobs[0] }],
  }), /duplicate job_id/);
  assert.throws(() => parseManifest({
    workflow: "test",
    jobs: [{ job_id: "x", workflow: "test", required: "yes", substantive: true, proves: "p", subset_allowed: false }],
  }), /must be boolean/);
});

test("conclusion mapping: skipped, neutral and absent are NOT-RUN, never green", () => {
  assert.equal(resultOf("success"), "PASSED");
  assert.equal(resultOf("failure"), "FAILED");
  assert.equal(resultOf("cancelled"), "FAILED");
  assert.equal(resultOf("skipped"), "NOT-RUN");
  assert.equal(resultOf("neutral"), "NOT-RUN");
  assert.equal(resultOf(null), "NOT-RUN");
  assert.equal(resultOf(undefined), "NOT-RUN");
});

test("all-pass run grades PASSED", () => {
  const grade = gradeJobs(manifest, ALL_PASS);
  assert.equal(grade.verdict, "PASSED");
  assert.deepEqual(grade.failed, []);
  assert.deepEqual(grade.notRun, []);
  assert.deepEqual(grade.unmanifested, []);
});

test("one failed substantive job grades FAILED and names it", () => {
  const grade = gradeJobs(manifest, { ...ALL_PASS, unit: "failure" });
  assert.equal(grade.verdict, "FAILED");
  assert.deepEqual(grade.failed, ["unit"]);
  assert.deepEqual(grade.notRun, []);
});

test("one skipped required job grades FAILED and names it NOT-RUN", () => {
  const grade = gradeJobs(manifest, { ...ALL_PASS, unit: "skipped" });
  assert.equal(grade.verdict, "FAILED");
  assert.deepEqual(grade.failed, []);
  assert.deepEqual(grade.notRun, ["unit"]);
});

test("coverage not run grades FAILED even when every other job passed", () => {
  // The laundering case the old receipt asserted as PASSED: coverage skipped
  // under an otherwise green run is a verdict failure, not a pass.
  const grade = gradeJobs(manifest, { ...ALL_PASS, coverage: "skipped" });
  assert.equal(grade.verdict, "FAILED");
  assert.deepEqual(grade.notRun, ["coverage"]);
});

test("a required job absent from the run grades FAILED as NOT-RUN", () => {
  const results = { ...ALL_PASS };
  delete results["safety-net"];
  const grade = gradeJobs(manifest, results);
  assert.equal(grade.verdict, "FAILED");
  assert.deepEqual(grade.notRun, ["safety-net"]);
});

test("a job in the run but not in the manifest is a defect and fails the verdict", () => {
  const grade = gradeJobs(manifest, { ...ALL_PASS, "mystery-job": "success" });
  assert.equal(grade.verdict, "FAILED");
  assert.deepEqual(grade.unmanifested, ["mystery-job"]);
});

test("an OUT-OF-SCOPE job is NOT-GRADED and its conclusion is never consulted", () => {
  const scoped = parseManifest({
    workflow: "test",
    jobs: [
      { job_id: "unit", workflow: "test", required: true, substantive: true, proves: "the unit suite", subset_allowed: false },
      { job_id: "external", workflow: "test", required: false, substantive: false, proves: "OUT-OF-SCOPE: not graded", subset_allowed: false },
    ],
  });
  const grade = gradeJobs(scoped, { unit: "success", external: "failure" });
  assert.equal(grade.verdict, "PASSED");
  assert.equal(grade.table.find(row => row.job_id === "external").verdict, "NOT-GRADED");
});

test("specimen: run 43750749856 (PR #6208 head 96f12308) grades FAILED", () => {
  // Job results at the exact head, from the run's jobs list (A001 evidence,
  // wave-100-value-2026-11-15 lane 01). The two OUT-OF-SCOPE rows are omitted
  // from the input entirely: the verdict must fail without consulting them.
  // In that run the old ci-verdict job reported success (job 132925697957)
  // because it exited 0 unconditionally.
  const specimen = {
    changes: "success",
    "safety-net": "success",
    coverage: "skipped",
    contract: "success",
    unit: "success",
    "friend-agent-e2e": "success",
    lint: "success",
    "browser-shards": "success",
    browser: "success",
    "visual-refresh-guard": "success",
    test: "failure",
    "ci-verdict": "success",
  };
  const grade = gradeJobs(manifest, specimen);
  assert.equal(grade.verdict, "FAILED");
  assert.deepEqual(grade.failed, ["test"]);
  assert.deepEqual(grade.notRun, ["coverage"]);
  const markdown = gradeMarkdown(grade, { subject: "pull request #6208 at head 96f12308c28f4a6cfc7ac05d5132875526c87f82" });
  assert.match(markdown, /\| coverage \| NOT-RUN \|/);
  assert.match(markdown, /\| test \| FAILED \|/);
});

test("display names map to manifest job ids; shard collapse takes the worst", () => {
  assert.equal(jobIdOfName("browser shard 3/6"), "browser-shards");
  assert.equal(jobIdOfName("browser"), "browser");
  assert.equal(jobIdOfName("ci-verdict (NOTHING RAN - add ready-to-land)"), "ci-verdict");
  assert.equal(jobIdOfName("unit"), "unit");
  assert.equal(worstConclusion("success", "failure"), "failure");
  assert.equal(worstConclusion("success", "skipped"), "skipped");
  assert.equal(worstConclusion(null, "success"), "success");
});

test("workflow env results map back to manifest job ids", () => {
  const results = resultsFromEnv({
    CI_JOB_RESULT_UNIT: "success",
    CI_JOB_RESULT_BROWSER_SHARDS: "skipped",
    CI_JOB_RESULT_CLOUDFLARE_SHARD_2: "failure",
    UNRELATED: "success",
  });
  assert.deepEqual(results, { unit: "success", "browser-shards": "skipped", "cloudflare-shard-2": "failure" });
});
