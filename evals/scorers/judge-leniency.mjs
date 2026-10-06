// Judge-leniency calibration (from matrixy/eval-layer).
// Every LLM-judged eval computes mean(judge_score − human_reference_score)
// on a small human-graded calibration set. |leniency| > 0.25 blocks trust
// in the scores: the judge is not used, and the eval is marked untrusted.

export const LENIENCY_BOUND = 0.25;

/** Mean(judgeScore − humanScore) over the calibration records. */
export function computeLeniency(records) {
  if (!records || records.length === 0) {
    throw new Error('leniency needs a non-empty calibration set');
  }
  const total = records.reduce((sum, r) => sum + (r.judgeScore - r.humanScore), 0);
  return total / records.length;
}

/** Trust gate: pass only when |leniency| is within the bound. */
export function leniencyGate(records) {
  const leniency = computeLeniency(records);
  return { leniency, bound: LENIENCY_BOUND, pass: Math.abs(leniency) <= LENIENCY_BOUND };
}

/**
 * Run an LLM judge over records only when the calibration gate passes.
 * A failing gate refuses to produce scores — nothing half-trusted.
 * records: [{ taskId, humanScore?, ...judgeInput }], judge: async (record) => number.
 */
export async function judgeWithTrustGate({ records, judge }) {
  const calibrated = records.filter((r) => typeof r.humanScore === 'number');
  const gate = leniencyGate(calibrated);
  if (!gate.pass) {
    return {
      trusted: false,
      gate,
      scores: null,
      blocked: `|leniency|=${Math.abs(gate.leniency).toFixed(3)} exceeds ${LENIENCY_BOUND}: judge scores not trusted`,
    };
  }
  const scores = [];
  for (const record of records) {
    scores.push({ taskId: record.taskId, judgeScore: await judge(record) });
  }
  return { trusted: true, gate, scores, blocked: null };
}
