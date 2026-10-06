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
