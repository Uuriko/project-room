// LLM-as-judge scorer. Fits the evals/ harness: a scorer is
// (task, outcome) => score in [0, 1]. Unlike the deterministic scorers,
// judgment is delegated to an injected judgeFn, so tests and CI never
// touch a model API — stubs do the grading there.
//
// WHERE A REAL LLM JUDGE PLUGS IN
// -------------------------------
// Pass a judgeFn adapter of shape: async ({ task, outcome, rubric }) => number.
// The adapter owns the LLM call: it renders the prompt from the rubric +
// task + outcome.trajectory, sends it to the model, and parses a score in
// [0, 1] from the response (e.g. the model's first float on [0,1], or a
// 1-10 rating scaled down). The scorer normalizes whatever comes back —
// out-of-range values are clamped, non-numeric values throw — so a sloppy
// parse cannot silently poison runEval aggregation.
// Before trusting any judge in production, run calibrate() over
// evals/calibration/judge-calibration-set.jsonl and gate on the agreement;
// evals/scorers/judge-leniency.mjs provides the trust gate (|leniency| > 0.25).

/** Clamp a judge's raw return into [0,1]; throws on non-numeric. */
function normalizeScore(raw) {
  const score = typeof raw === 'number' ? raw : raw?.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(`judge returned non-numeric score: ${JSON.stringify(raw)?.slice(0, 120)}`);
  }
  return Math.min(1, Math.max(0, score));
}

/**
 * Build a judge-backed scorer for the evals/ harness.
 * @param {{ judgeFn: (input: { task, outcome, rubric }) => Promise<number>|number,
 *            rubric: string }} opts
 * @returns {(task, outcome) => Promise<number>} score in [0,1]
 */
export function createJudgeScorer({ judgeFn, rubric }) {
  if (typeof judgeFn !== 'function') {
    throw new Error('createJudgeScorer needs a judgeFn function');
  }
  if (typeof rubric !== 'string' || rubric.length === 0) {
    throw new Error('createJudgeScorer needs a non-empty rubric string');
  }

  return async (task, outcome) => {
    const normalized = outcome ?? {};
    const judgeInput = {
      task,
      outcome: { ...normalized, trajectory: normalized.trajectory ?? [] },
      rubric,
    };
    const raw = await judgeFn(judgeInput);
    return normalizeScore(raw);
  };
}

/**
 * Measure judge/human agreement over a calibration set: mean |judge − human|.
 * @param {(record) => Promise<number>|number} judgeFn — grades one calibration record
 * @param {Array<{ taskId: string, humanScore: number }>} calibrationSet — e.g. loaded
 *        from evals/calibration/judge-calibration-set.jsonl via loadJsonl
 * @returns {{ n: number, mae: number, perTask: Array<{ taskId, humanScore, judgeScore, absErr }> }}
 */
export async function calibrate(judgeFn, calibrationSet) {
  if (typeof judgeFn !== 'function') {
    throw new Error('calibrate needs a judgeFn function');
  }
  if (!Array.isArray(calibrationSet) || calibrationSet.length === 0) {
    throw new Error('calibrate needs a non-empty calibration set');
  }

  const perTask = [];
  for (const record of calibrationSet) {
    const judgeScore = normalizeScore(await judgeFn(record));
    const absErr = Math.abs(judgeScore - record.humanScore);
    perTask.push({ taskId: record.taskId, humanScore: record.humanScore, judgeScore, absErr });
  }
  const mae = perTask.reduce((sum, r) => sum + r.absErr, 0) / perTask.length;
  return { n: perTask.length, mae, perTask };
}
