// Read-only merge-train planner: check selection and greedy batching.
import test from "node:test";
import assert from "node:assert/strict";
import { checksGreen, planBatches, isGenerated } from "../scripts/train-plan.mjs";

test("required checks must each be green at their latest run", () => {
  const runs = [
    { name: "test", conclusion: "failure", started_at: "2026-10-28T01:00:00Z" },
    { name: "test", conclusion: "success", started_at: "2026-10-28T02:00:00Z" },
    { name: "contract", conclusion: "success" }, { name: "lint", conclusion: "success" },
    { name: "browser", conclusion: "success" }, { name: "cloudflare", conclusion: "skipped" }
  ];
  assert.deepEqual(checksGreen(runs), { green: false, missing: ["cloudflare"] });
  runs[5].conclusion = "success";
  assert.deepEqual(checksGreen(runs), { green: true, missing: [] });
});

test("generated files are recognised in both errors-catalog copies", () => {
  assert.equal(isGenerated("scripts/CANDIDATE-MANIFEST.json"), true);
  assert.equal(isGenerated("plugins/project-room/skills/project-room/references/errors-catalog.md"), true);
  assert.equal(isGenerated("server/store.mjs"), false);
});

test("batches keep order, cap size, and defer PRs that conflict with the batch", () => {
  const files = { 1: ["a"], 2: ["b"], 3: ["a"], 4: ["c"], 5: ["d"] };
  // A fake merge: conflict when the PR touches a file already in the tip.
  const tryMerge = (tip, pr) => {
    const touched = new Set(tip);
    if (files[pr.number].some(file => touched.has(file))) return { ok: false, conflicts: files[pr.number] };
    return { ok: true, next: [...tip, ...files[pr.number]] };
  };
  const { batches, skipped } = planBatches([1, 2, 3, 4, 5].map(number => ({ number })), { batchSize: 3, tryMerge, start: [] });
  assert.deepEqual(batches.map(batch => batch.map(pr => pr.number)), [[1, 2, 4], [5]]);
  assert.deepEqual(skipped.map(pr => pr.number), [3], "#3 conflicts with #1 on main and stays out");
});
