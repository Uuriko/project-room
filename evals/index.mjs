// evals/ harness runner — inspect_ai-style Dataset → Solver → Scorer decomposition.
// A dataset is a pinned JSONL of task records. A solver is an async function
// (task) => outcome, where outcome = { trajectory, finalAnswer }. Scorers are
// async (or sync) functions (task, outcome) => score in [0, 1].

import { readFile } from 'node:fs/promises';

/** Load a pinned task dataset: one JSON object per line, blank lines ignored. */
export async function loadJsonl(filePath) {
  const text = await readFile(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`invalid JSONL at ${filePath}:${i + 1}: ${err.message}`);
      }
    });
}

/**
 * Run every task through the solver, then every scorer over the outcome.
 *
 * Edge-case contract (pinned by tests/evals-harness.test.js):
 * - Deterministic-first: a task passes only when every scorer returns
 *   exactly 1. A fractional score (e.g. 0.5) fails the task; the raw score
 *   is still recorded as-is in result.scores and counts in the summary.
 * - Zero scorers ({} or omitted) is a vacuous pass: with nothing to check,
 *   "every scorer returned 1" is true, so every task passes.
 * - A missing outcome trajectory defaults to [].
 * - Task ids must be unique: duplicates throw before any task runs, because
 *   results are keyed by task id.
 * - A solver throw aborts the run with an error naming the task id
 *   (original error kept as `cause`).
 */
export async function runEval({ tasks, solver, scorers }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('runEval needs a non-empty tasks array');
  }
  if (typeof solver !== 'function') throw new Error('runEval needs a solver function');

  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new Error(`runEval: duplicate task id "${task.id}" — task ids must be unique`);
    }
    seen.add(task.id);
  }

  const results = [];
  for (const task of tasks) {
    let outcome;
    try {
      outcome = await solver(task);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`runEval: solver failed for task "${task.id}": ${reason}`, { cause: err });
    }
    const scores = {};
    for (const [name, scorer] of Object.entries(scorers ?? {})) {
      const score = await scorer(task, outcome);
      if (typeof score !== 'number' || Number.isNaN(score)) {
        throw new Error(`scorer "${name}" returned non-numeric score for task ${task.id}`);
      }
      scores[name] = score;
    }
    results.push({
      taskId: task.id,
      scores,
      passed: Object.values(scores).every((s) => s === 1),
      trajectory: outcome?.trajectory ?? [],
    });
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    summary: { total: results.length, passed, failed: results.length - passed },
  };
}
