// Held-out split contract tests (Crew C lane C2).
// Authoring-gate answers:
// 1. Protects the anti-overfitting contract of evals/heldout.mjs: the
//    held-out set is deterministic, disjoint from train, honors the requested
//    fraction, and is stable under input reordering — so tuning on train can
//    never leak into the validation split.
// 2. Credible regressions: someone replaces the id-hash assignment with
//    Math.random() (split drifts run to run), lets a task land in both
//    splits, or drops the fraction threshold.
// 3. No existing coverage: evals/index.mjs has no split; this test file is the
//    sole owner of the split contract.
// 4. No production seam: tests call the exported functions directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const tasks = (n, prefix = 'task') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, solver: 'x' }));

test('heldout module exposes splitHeldOut and runEvalHeldOut', async () => {
  const { splitHeldOut, runEvalHeldOut } = await import('../evals/heldout.mjs');
  assert.equal(typeof splitHeldOut, 'function');
  assert.equal(typeof runEvalHeldOut, 'function');
});

test('split is deterministic: same input, identical split across runs', async () => {
  const { splitHeldOut } = await import('../evals/heldout.mjs');
  const input = tasks(200);
  const a = splitHeldOut(input, { holdoutFraction: 0.2 });
  const b = splitHeldOut(input, { holdoutFraction: 0.2 });
  assert.deepEqual(
    a.heldOut.map((t) => t.id),
    b.heldOut.map((t) => t.id),
  );
  assert.deepEqual(
    a.train.map((t) => t.id),
    b.train.map((t) => t.id),
  );
});

test('splits are disjoint and jointly exhaustive', async () => {
  const { splitHeldOut } = await import('../evals/heldout.mjs');
  const input = tasks(200);
  const { train, heldOut } = splitHeldOut(input, { holdoutFraction: 0.2 });
  const trainIds = new Set(train.map((t) => t.id));
  const heldOutIds = new Set(heldOut.map((t) => t.id));
  const overlap = [...heldOutIds].filter((id) => trainIds.has(id));
  assert.equal(overlap.length, 0, `task(s) in both splits: ${overlap}`);
  assert.equal(train.length + heldOut.length, input.length);
  assert.equal(trainIds.size + heldOutIds.size, input.length);
});

test('fraction is approximately honored at scale', async () => {
  const { splitHeldOut } = await import('../evals/heldout.mjs');
  const input = tasks(1000);
  const { heldOut } = splitHeldOut(input, { holdoutFraction: 0.2 });
  const frac = heldOut.length / input.length;
  assert.ok(frac >= 0.15 && frac <= 0.25, `held-out fraction ${frac} outside tolerance`);
});

test('empty input yields empty splits', async () => {
  const { splitHeldOut } = await import('../evals/heldout.mjs');
  const { train, heldOut } = splitHeldOut([], { holdoutFraction: 0.2 });
  assert.deepEqual(train, []);
  assert.deepEqual(heldOut, []);
});

test('single task lands wholly in one split, deterministically', async () => {
  const { splitHeldOut } = await import('../evals/heldout.mjs');
  const input = [{ id: 'only-one', solver: 'x' }];
  const a = splitHeldOut(input, { holdoutFraction: 0.2 });
  const b = splitHeldOut(input, { holdoutFraction: 0.2 });
  assert.equal(a.train.length + a.heldOut.length, 1);
  assert.deepEqual(a, b, 'single-task split must be deterministic');
});

test('split is stable under input reordering', async () => {
  const { splitHeldOut } = await import('../evals/heldout.mjs');
  const input = tasks(200);
  const shuffled = [...input].reverse();
  const a = splitHeldOut(input, { holdoutFraction: 0.2 });
  const b = splitHeldOut(shuffled, { holdoutFraction: 0.2 });
  const ids = (xs) => xs.map((t) => t.id).sort();
  assert.deepEqual(ids(a.heldOut), ids(b.heldOut), 'held-out membership must not depend on order');
  assert.deepEqual(ids(a.train), ids(b.train), 'train membership must not depend on order');
});

test('task without id is rejected fail-fast', async () => {
  const { splitHeldOut } = await import('../evals/heldout.mjs');
  assert.throws(() => splitHeldOut([{ solver: 'x' }], { holdoutFraction: 0.2 }), /id/);
});

test('runEvalHeldOut reports train and held-out scores separately', async () => {
  const { runEvalHeldOut } = await import('../evals/heldout.mjs');
  const input = tasks(100, 'eval');
  const solver = (task) => ({ trajectory: [`ran ${task.id}`], finalAnswer: 'ok' });
  const scorers = { exact: () => 1 };
  const report = await runEvalHeldOut({ tasks: input, solver, scorers, holdoutFraction: 0.2 });
  assert.ok(report.train && report.heldOut, 'report must carry train and heldOut');
  assert.equal(report.train.summary.total + report.heldOut.summary.total, input.length);
  const allIds = [
    ...report.train.results.map((r) => r.taskId),
    ...report.heldOut.results.map((r) => r.taskId),
  ];
  assert.equal(new Set(allIds).size, input.length, 'no task scored twice, none skipped');
  assert.equal(report.train.summary.failed, 0);
  assert.equal(report.heldOut.summary.failed, 0);
});
