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
 * A task passes only when every scorer returns exactly 1 (deterministic-first).
 */
export async function runEval({ tasks, solver, scorers }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('runEval needs a non-empty tasks array');
  }
  if (typeof solver !== 'function') throw new Error('runEval needs a solver function');

  const results = [];
  for (const task of tasks) {
    const outcome = await solver(task);
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
