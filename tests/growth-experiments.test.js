// VL-1a experiment assignment. The arm is a pure function of the experiment
// and the unit, so a cached page cannot flip between renders.
import assert from "node:assert/strict";
import test from "node:test";
import { assignVariant, defineExperiment, listExperiments } from "../server/growth-experiments.mjs";

test("the seeded experiments are the assigned virality placement tests", () => {
  const experiments = listExperiments();
  assert.deepEqual(experiments.map(experiment => experiment.id), [
    "pr_footer_placement",
  ]);
  assert.deepEqual(experiments.map(experiment => [...experiment.arms]), [
    ["bottom", "top"],
  ]);
  assert.deepEqual(experiments.map(experiment => experiment.metric), [
    "public_artifact_cta_clicked",
  ]);
  assert.ok(experiments.every(experiment => experiment.minSamplePerArm === 400));
});

test("assignment is deterministic for one unit and rejects an unknown experiment", () => {
  const env = {};
  const first = assignVariant("pr_footer_placement", "rcpt:wcr_example", env);
  assert.equal(assignVariant("pr_footer_placement", "rcpt:wcr_example", env), first);
  assert.ok(first === "bottom" || first === "top");
  assert.throws(() => assignVariant("not_an_experiment", "rcpt:wcr_example", env), /unknown experiment/);
  assert.throws(() => defineExperiment({ id: "solo", arms: ["only"], metric: "public_artifact_cta_clicked", minSamplePerArm: 400 }), /2 to 8 arms/);
});

test("ten thousand units split within 3 percent per arm", () => {
  const counts = { bottom: 0, top: 0 };
  for (let i = 0; i < 10_000; i += 1) counts[assignVariant("pr_footer_placement", `unit-${i}`, {})] += 1;
  assert.ok(Math.abs(counts.bottom - 5_000) / 10_000 <= 0.03, `bottom=${counts.bottom} top=${counts.top}`);
  assert.equal(counts.bottom + counts.top, 10_000);
});

test("GROWTH_FORCE_ARMS pins a known arm and ignores an unknown one", () => {
  const natural = assignVariant("pr_footer_placement", "rcpt:1", {});
  assert.equal(assignVariant("pr_footer_placement", "rcpt:1", { GROWTH_FORCE_ARMS: "pr_footer_placement:nope" }), natural);
  assert.equal(assignVariant("pr_footer_placement", "pr:1", { GROWTH_FORCE_ARMS: "pr_footer_placement:top" }), "top");
  assert.equal(assignVariant("pr_footer_placement", "pr:1", { GROWTH_FORCE_ARMS: "unknown:ignored, pr_footer_placement:top" }), "top");
});
