// Read-only merge-train planner: check selection and greedy batching.
import test from "node:test";
import assert from "node:assert/strict";
import { checksGreen, planBatches, isGenerated, parseArgs } from "../scripts/train-plan.mjs";

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

test("a queued rerun with no start time beats an older success", () => {
  const base = ["contract", "lint", "browser", "cloudflare"].map((name, i) => ({ id: 10 + i, name, conclusion: "success", started_at: "2026-10-28T01:00:00Z" }));
  const runs = [...base, { id: 1, name: "test", conclusion: "success", started_at: "2026-10-28T01:00:00Z" }, { id: 99, name: "test", conclusion: null, started_at: null }];
  assert.deepEqual(checksGreen(runs), { green: false, missing: ["test"] });
});

test("generated files are recognised in both errors-catalog copies", () => {
  assert.equal(isGenerated("scripts/CANDIDATE-MANIFEST.json"), true);
  assert.equal(isGenerated("plugins/project-room/skills/project-room/references/errors-catalog.md"), true);
  assert.equal(isGenerated("server/store.mjs"), false);
  assert.equal(isGenerated("customer-owned/errors-catalog.md"), false, "exact paths only, no suffix match");
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

test("batch size must be an integer from 1 to 100", () => {
  const tryMerge = () => ({ ok: true, next: [] });
  for (const batchSize of [0, -1, 1.5, Number.NaN, 101, "10"]) {
    assert.throws(() => planBatches([{ number: 1 }], { batchSize, tryMerge, start: [] }), RangeError, String(batchSize));
  }
  assert.deepEqual(planBatches([{ number: 1 }], { batchSize: 1, tryMerge, start: [] }).batches.length, 1);
  assert.throws(() => planBatches([], { batchSize: 1, start: [] }), TypeError);
});

test("boundaries: no candidates, everything conflicting, and a batch of exactly the size", () => {
  const ok = (tip, pr) => ({ ok: true, next: [...tip, pr.number] });
  assert.deepEqual(planBatches([], { batchSize: 3, tryMerge: ok, start: [] }), { batches: [], skipped: [], tips: [] });
  const none = planBatches([{ number: 1 }, { number: 2 }], { batchSize: 3, tryMerge: () => ({ ok: false, conflicts: ["x"] }), start: [] });
  assert.deepEqual([none.batches.length, none.skipped.map(pr => pr.number)], [0, [1, 2]]);
  const exact = planBatches([1, 2, 3].map(number => ({ number })), { batchSize: 3, tryMerge: ok, start: [] });
  assert.deepEqual(exact.batches.map(batch => batch.length), [3]);
  assert.deepEqual(exact.tips, [[1, 2, 3]], "each batch reports the tip it ends on");
});

test("command-line options are validated", () => {
  assert.deepEqual(parseArgs([]).batch, 10);
  assert.equal(parseArgs(["--batch", "5", "--limit", "50"]).batch, 5);
  for (const bad of [["--batch", "0"], ["--batch", "x"], ["--limit", "-1"], ["--batch"], ["--nope", "1"], ["batch", "5"], ["--repo", "not a repo"]]) {
    assert.throws(() => parseArgs(bad), Error, bad.join(" "));
  }
});
