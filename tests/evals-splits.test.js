// Train/dev/test split + test-hiding guard tests (failing-first).
// Contract under test: the 3-way split is deterministic, disjoint and exhaustive;
// the test split is provably never shown to the agent (solver) under evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitHeldOut, // existing 2-way API — must keep working
  splitTrainDevTest,
  createSplitGuard,
  runEvalSealed,
} from '../evals/heldout.mjs';

const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `t-${String(i).padStart(3, '0')}` }));

test('3-way split is disjoint, exhaustive and deterministic', () => {
  const a = splitTrainDevTest(tasks, { devFraction: 0.15, testFraction: 0.15 });
  const b = splitTrainDevTest([...tasks].reverse(), { devFraction: 0.15, testFraction: 0.15 });
  const ids = (xs) => new Set(xs.map((t) => t.id));
  const all = new Set([...ids(a.train), ...ids(a.dev), ...ids(a.test)]);
  assert.equal(all.size, 100, 'every task lands in exactly one split');
  assert.equal(ids(a.train).intersection(ids(a.dev)).size, 0);
  assert.equal(ids(a.train).intersection(ids(a.test)).size, 0);
  assert.equal(ids(a.dev).intersection(ids(a.test)).size, 0);
  assert.deepEqual(
    [...ids(a.test)].sort(),
    [...ids(b.test)].sort(),
    'membership is order-independent (hash of task id, not position)',
  );
  assert.ok(a.test.length > 0 && a.dev.length > 0 && a.train.length > 0, 'all splits non-empty at these fractions');
});

test('fractions are validated', () => {
  assert.throws(() => splitTrainDevTest(tasks, { devFraction: -0.1, testFraction: 0.1 }), /fraction/i);
  assert.throws(() => splitTrainDevTest(tasks, { devFraction: 0.6, testFraction: 0.6 }), /exceed/i);
  assert.throws(() => splitTrainDevTest(tasks, { devFraction: 0, testFraction: 1.5 }), /fraction/i);
});

test('existing 2-way split API is unchanged', () => {
  const { train, heldOut } = splitHeldOut(tasks, { holdoutFraction: 0.2 });
  assert.equal(train.length + heldOut.length, 100);
  const ids = new Set([...train, ...heldOut].map((t) => t.id));
  assert.equal(ids.size, 100);
});

test('split guard throws when a solver touches a hidden test task', async () => {
  const { test } = splitTrainDevTest(tasks, { devFraction: 0.15, testFraction: 0.15 });
  const visible = new Set(tasks.filter((t) => !test.some((x) => x.id === t.id)).map((t) => t.id));
  const guard = createSplitGuard({ visibleIds: visible });
  const sneaky = guard(async (task) => ({ trajectory: [], finalAnswer: 'x' }));
  await sneaky({ id: [...visible][0] }); // visible task passes through
  await assert.rejects(() => sneaky(test[0]), new RegExp(test[0].id), 'guard must name the leaked task id');
});

test('sealed run never shows test tasks to the tuning solver', async () => {
  const seen = [];
  const tuneSolver = async (task) => {
    seen.push(task.id);
    return { trajectory: [], finalAnswer: 'tuned' };
  };
  const testSolver = async (task) => ({ trajectory: [], finalAnswer: 'final' });
  const scorers = { always: async () => 1 };
  const report = await runEvalSealed({ tasks, tuneSolver, testSolver, scorers });
  const testIds = new Set(report.splits.testIds);
  assert.ok(report.test.summary.total === testIds.size && testIds.size > 0);
  assert.deepEqual(
    report.test.results.map((r) => r.taskId).sort(),
    [...testIds].sort(),
    'test report covers exactly the test split',
  );
  const leaked = seen.filter((id) => testIds.has(id));
  assert.equal(leaked.length, 0, `tuning solver saw test tasks: ${leaked.join(',')}`);
});

test('test-phase guard rejects non-test tasks (final run stays test-only)', async () => {
  const { train, test: testSplit } = splitTrainDevTest(tasks, { devFraction: 0.15, testFraction: 0.15 });
  // Same guard construction runEvalSealed uses for its final phase.
  const guard = createSplitGuard({ visibleIds: new Set(testSplit.map((t) => t.id)), phase: 'test' });
  const finalSolver = guard(async (task) => ({ trajectory: [], finalAnswer: 'final' }));
  await finalSolver(testSplit[0]); // test task passes through
  await assert.rejects(
    () => finalSolver(train[0]),
    (err) => {
      assert.equal(err.code, 'TEST_SPLIT_LEAK');
      assert.ok(err.message.includes(train[0].id), 'leak error must name the task id');
      assert.ok(err.message.includes('"test"'), 'leak error must name the phase');
      return true;
    },
    'running the final solver on a train task must abort, not silently score',
  );
});
