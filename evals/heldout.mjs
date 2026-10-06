// evals/heldout.mjs — deterministic held-out split for eval tasks.
//
// ANTI-OVERFITTING RATIONALE:
// Pinned eval datasets (evals/datasets/tasks/*.jsonl) are the harness's
// ground truth, but tuning solvers until they score 1.0 on the pinned set and
// calling that "done" is overfitting to the eval itself — the score says the
// solver memorized the tasks, not that it generalizes. The
// EVALUATION_CHECKLIST.md therefore requires a held-out validation run, and
// evals/datasets/README.md says the validation split must be disjoint from
// the tasks the solver was developed against.
//
// This module implements that requirement mechanically:
//   1. The split is derived from sha256(task.id), not from RNG state — so the
//      same task always lands in the same split across runs, machines, and
//      dataset reorderings. There is no seed to mis-set and no ordering to
//      game; membership is a pure function of the pinned task id.
//   2. Every task lands in exactly one of {train, heldOut} — never both, never
//      neither — so tuning on `train` can never leak into the validation set.
//   3. runEvalHeldOut runs the same solver+scorers against both splits and
//      reports the scores separately, so a solver that overfit the train set
//      shows up as a train-vs-held-out score gap instead of a single flattering
//      number.
//
// If a task id ever changes (README: add a new id, never edit in place) the
// split moves with it deterministically — still no leak, since id edits are
// deliberate dataset revisions, not silent tuning.
//
// THREE-WAY SPLITS: splitTrainDevTest partitions into { train, dev, test }.
// runEvalGuardedSplits wraps the tuning solver in a split guard that throws
// (fail-closed, naming the task) if any task outside the train+dev ids reaches
// it, and wraps the final solver so it only ever sees test ids.
//
// HONEST LIMITS (this is a guarded deterministic split, not a sealed test set):
//   - Split assignment is deterministic (repeatable) via the public sha256(id)
//     hash — it is predictable, not secret. Anyone holding the task array can
//     compute the split.
//   - The guard only checks the task passed to the WRAPPED solver. It cannot
//     stop the caller from inspecting the task array, reading test tasks
//     directly, running the solver outside the wrapper, or tuning repeatedly
//     on test scores. The report itself lists all split ids.
//   - What the guard does catch: accidentally (or carelessly) pointing the
//     tuning solver at a test task through the harness — that aborts loudly
//     instead of silently producing a contaminated score.

import { createHash } from 'node:crypto';
import { runEval } from './index.mjs';

const UINT64_MAX = 0xffffffffffffffffn;

/** Uniform value in [0, 1) derived deterministically from a task id. */
export function heldOutScore(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('splitHeldOut needs a non-empty string id on every task');
  }
  const digest = createHash('sha256').update(taskId, 'utf8').digest();
  const u64 = digest.readBigUInt64BE(0);
  return Number(u64) / Number(UINT64_MAX);
}

/**
 * Deterministic train/held-out split by task-id hash.
 * A task goes to heldOut iff heldOutScore(task.id) < holdoutFraction.
 * Membership is order-independent and reproducible across runs/machines.
 */
export function splitHeldOut(tasks, { holdoutFraction = 0.2 } = {}) {
  if (!Array.isArray(tasks)) throw new Error('splitHeldOut needs a tasks array');
  if (typeof holdoutFraction !== 'number' || holdoutFraction < 0 || holdoutFraction > 1) {
    throw new Error('holdoutFraction must be a number in [0, 1]');
  }
  const train = [];
  const heldOut = [];
  for (const task of tasks) {
    (heldOutScore(task?.id) < holdoutFraction ? heldOut : train).push(task);
  }
  return { train, heldOut };
}

const emptyReport = () => ({ results: [], summary: { total: 0, passed: 0, failed: 0 } });

/**
 * Run solver+scorers against the train and held-out splits separately.
 * Report shape: { train: runEval-report, heldOut: runEval-report, holdoutFraction }.
 * Empty splits yield a zeroed report instead of runEval's non-empty throw.
 */
export async function runEvalHeldOut({ tasks, solver, scorers, holdoutFraction = 0.2 }) {
  const { train, heldOut } = splitHeldOut(tasks, { holdoutFraction });
  const [trainReport, heldOutReport] = await Promise.all([
    train.length > 0 ? runEval({ tasks: train, solver, scorers }) : emptyReport(),
    heldOut.length > 0 ? runEval({ tasks: heldOut, solver, scorers }) : emptyReport(),
  ]);
  return { train: trainReport, heldOut: heldOutReport, holdoutFraction };
}

/**
 * Deterministic train/dev/test split by task-id hash.
 * A task goes to test iff heldOutScore(task.id) < testFraction, to dev iff the
 * score is below testFraction + devFraction, else to train. Disjoint,
 * exhaustive, order-independent — same hash discipline as splitHeldOut.
 */
export function splitTrainDevTest(tasks, { devFraction = 0.15, testFraction = 0.15 } = {}) {
  if (!Array.isArray(tasks)) throw new Error('splitTrainDevTest needs a tasks array');
  for (const [label, f] of [['devFraction', devFraction], ['testFraction', testFraction]]) {
    if (typeof f !== 'number' || Number.isNaN(f) || f < 0 || f > 1) {
      throw new Error(`${label} must be a number in [0, 1]`);
    }
  }
  if (devFraction + testFraction > 1) {
    throw new Error(`devFraction + testFraction must not exceed 1 (got ${devFraction + testFraction})`);
  }
  const train = [];
  const dev = [];
  const test = [];
  for (const task of tasks) {
    const s = heldOutScore(task?.id);
    if (s < testFraction) test.push(task);
    else if (s < testFraction + devFraction) dev.push(task);
    else train.push(task);
  }
  return { train, dev, test };
}

/**
 * Split guard: wraps a solver so it can only ever be invoked with tasks whose
 * ids are in `visibleIds`. Any other task throws fail-closed with code
 * TEST_SPLIT_LEAK, naming the phase and the task id. The guard is a misuse
 * tripwire inside the harness — it catches a solver being pointed at the wrong
 * split through the wrapper. It does not (and cannot) prevent the caller from
 * reading tasks outside the wrapper or inspecting the task array directly.
 */
export function createSplitGuard({ visibleIds, phase = 'tuning' } = {}) {
  const visible = visibleIds instanceof Set ? visibleIds : new Set(visibleIds ?? []);
  return (solver) => async (task) => {
    if (!visible.has(task?.id)) {
      const err = new Error(
        `test-split leak: phase "${phase}" solver was shown task "${task?.id}", which is outside its visible split`,
      );
      err.code = 'TEST_SPLIT_LEAK';
      throw err;
    }
    return solver(task);
  };
}

/**
 * Guarded-split evaluation: tuning runs against train+dev only, the final run
 * against test only. Both solvers are guard-wrapped, so a test task reaching
 * the tuning solver (or a non-test task reaching the final solver) through the
 * wrapper aborts the run. This is NOT a sealed test set — see the HONEST
 * LIMITS note at the top of this module: split assignment is public and
 * predictable, the report lists every split id, and the guard cannot stop the
 * caller from reading tasks outside the wrapper.
 * Report shape: { train, dev, test, splits: { trainIds, devIds, testIds },
 * devFraction, testFraction }.
 */
export async function runEvalGuardedSplits({
  tasks,
  tuneSolver,
  testSolver,
  scorers,
  devFraction = 0.15,
  testFraction = 0.15,
}) {
  if (typeof tuneSolver !== 'function') throw new Error('runEvalGuardedSplits needs a tuneSolver function');
  if (typeof testSolver !== 'function') throw new Error('runEvalGuardedSplits needs a testSolver function');
  const { train, dev, test } = splitTrainDevTest(tasks, { devFraction, testFraction });
  const trainIds = train.map((t) => t.id);
  const devIds = dev.map((t) => t.id);
  const testIds = test.map((t) => t.id);

  const guardedTune = createSplitGuard({ visibleIds: [...trainIds, ...devIds], phase: 'tuning' })(tuneSolver);
  const guardedTest = createSplitGuard({ visibleIds: testIds, phase: 'test' })(testSolver);

  const [trainReport, devReport] = await Promise.all([
    train.length > 0 ? runEval({ tasks: train, solver: guardedTune, scorers }) : emptyReport(),
    dev.length > 0 ? runEval({ tasks: dev, solver: guardedTune, scorers }) : emptyReport(),
  ]);
  const testReport = test.length > 0 ? await runEval({ tasks: test, solver: guardedTest, scorers }) : emptyReport();

  return {
    train: trainReport,
    dev: devReport,
    test: testReport,
    splits: { trainIds, devIds, testIds },
    devFraction,
    testFraction,
  };
}
