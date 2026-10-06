// LLM-as-judge scorer — failing-first contract tests (Crew C lane C1).
// Authoring gate: these guard the NEW public contract of evals/scorers/llm-judge.mjs.
// Deterministic scorers (deterministic.mjs, evals-harness.test.js) do not cover it:
//   1. scorer contract — (task, outcome) => number in [0,1], missing trajectory tolerated.
//      Regression: an out-of-range/NaN judge score leaking into runEval, or a crash
//      when the solver omits trajectory, would corrupt every LLM-judged eval.
//   2. rubric inclusion — the rubric text must reach the judge prompt input.
//      Regression: factory silently dropping the rubric (judge grades on vibes).
//   3. calibration math — calibrate(judgeFn, set) computes MAE vs humanScore.
//      Regression: wrong agreement numbers would mistune the trust gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const calibrationPath = path.join(root, 'evals', 'calibration', 'judge-calibration-set.jsonl');

test('createJudgeScorer: returns number in [0,1] for a stub judge', async () => {
  const { createJudgeScorer } = await import('../evals/scorers/llm-judge.mjs');
  const score = createJudgeScorer({
    rubric: 'Grade the trajectory 0-1.',
    judgeFn: async () => 0.7,
  });
  assert.equal(typeof score, 'function');
  const got = await score({ id: 't1' }, { trajectory: [{ tool: 'x' }] });
  assert.equal(got, 0.7);
  assert.ok(got >= 0 && got <= 1, 'score must be in [0,1]');
});

test('createJudgeScorer: tolerates missing trajectory and missing outcome', async () => {
  const { createJudgeScorer } = await import('../evals/scorers/llm-judge.mjs');
  const seen = [];
  const score = createJudgeScorer({
    rubric: 'R',
    judgeFn: async (input) => {
      seen.push(input);
      return 0.5;
    },
  });
  const got1 = await score({ id: 't1' }, { finalAnswer: 'done' });
  assert.equal(got1, 0.5);
  const got2 = await score({ id: 't1' });
  assert.equal(got2, 0.5);
  assert.ok(Array.isArray(seen[0].outcome.trajectory), 'judge sees normalized trajectory');
  assert.ok(Array.isArray(seen[1].outcome.trajectory), 'judge sees normalized trajectory');
});

test('createJudgeScorer: clamps out-of-range scores into [0,1], rejects non-numeric', async () => {
  const { createJudgeScorer } = await import('../evals/scorers/llm-judge.mjs');
  const hi = createJudgeScorer({ rubric: 'R', judgeFn: async () => 1.9 });
  const lo = createJudgeScorer({ rubric: 'R', judgeFn: async () => -0.4 });
  assert.equal(await hi({}, {}), 1);
  assert.equal(await lo({}, {}), 0);
  const bad = createJudgeScorer({ rubric: 'R', judgeFn: async () => 'great' });
  await assert.rejects(() => bad({}, {}), /non-numeric/);
});

test('createJudgeScorer: passes rubric, task, and outcome through to judgeFn', async () => {
  const { createJudgeScorer } = await import('../evals/scorers/llm-judge.mjs');
  const rubric = 'UNIQUE-RUBRIC-TEXT-crew-c1';
  let input = null;
  const score = createJudgeScorer({
    rubric,
    judgeFn: async (i) => {
      input = i;
      return 0.3;
    },
  });
  const task = { id: 't-rubric' };
  const outcome = { trajectory: [{ tool: 'room.join' }] };
  await score(task, outcome);
  assert.equal(input.rubric, rubric, 'rubric must reach the judge input');
  assert.equal(input.task, task);
  assert.equal(input.outcome.trajectory, outcome.trajectory);
});

test('calibrate: mean absolute error vs humanScore over a stubbed judge', async () => {
  const { calibrate } = await import('../evals/scorers/llm-judge.mjs');
  const { loadJsonl } = await import('../evals/index.mjs');
  const records = await loadJsonl(calibrationPath);
  assert.ok(records.length >= 2);
  // Stub: judge always returns humanScore + 0.1 (clamped at 1) → MAE known.
  const judgeFn = async (record) => Math.min(1, record.humanScore + 0.1);
  const result = await calibrate(judgeFn, records);
  const expected = records.reduce(
    (sum, r) => sum + Math.abs(Math.min(1, r.humanScore + 0.1) - r.humanScore),
    0,
  ) / records.length;
  assert.equal(result.n, records.length);
  assert.ok(Math.abs(result.mae - expected) < 1e-12, `mae ${result.mae} ≈ ${expected}`);
  assert.ok(result.perTask.every((r) => typeof r.absErr === 'number'));
});

test('calibrate: reports per-task errors so mistuned judges are debuggable', async () => {
  const { calibrate } = await import('../evals/scorers/llm-judge.mjs');
  const judgeFn = async () => 0;
  const result = await calibrate(judgeFn, [
    { taskId: 'a', humanScore: 1 },
    { taskId: 'b', humanScore: 0 },
  ]);
  assert.equal(result.mae, 0.5);
  assert.equal(result.perTask[0].taskId, 'a');
  assert.equal(result.perTask[0].absErr, 1);
});

test('calibrate: rejects empty calibration sets', async () => {
  const { calibrate } = await import('../evals/scorers/llm-judge.mjs');
  await assert.rejects(() => calibrate(async () => 0.5, []), /non-empty/);
});
