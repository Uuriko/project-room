// evals/scorers/llm-judge.mjs — LLM-as-judge scoring for the evals/ harness.
//
// Rubric-based scoring with structured output. The module is transport-agnostic:
// the actual model call is an injected `judgeFn` ({ prompt, seed, attempt }) => string,
// so no LLM provider is hard-coded anywhere here — swap the transport without
// touching the scoring logic.
//
// REPRODUCIBILITY CONTRACT (narrowed — read the limits):
//   1. The prompt is a pure function of (rubric, task, outcome, seed). Same inputs
//      render byte-identical prompts (see buildJudgePrompt); the seed is printed
//      verbatim in the prompt, passed to judgeFn, and logged with every judgment.
//   2. Every judgment attempt is appended to `journal`: { taskId, seed, attempt,
//      promptHash, judgmentHash, score?, rationale?, error? }.
//   3. Retries re-send the SAME prompt (no repair mutation), so promptHash is
//      stable across attempts; stochastic providers absorb the retry.
//
// LIMITS: the module cannot control the provider behind judgeFn — model,
// version, temperature, and seed semantics are the transport's business. Same
// seed does NOT guarantee same scores across providers or provider versions;
// it only makes the module's own input (the prompt) deterministic and auditable.
// The journal's promptHash/judgmentHash let a later run verify what was sent
// and received, not reproduce a provider's sampling.
//
// FAIL-CLOSED: a judgment that does not parse as the required schema is retried
// up to maxRetries; persistent malformed output throws instead of producing a
// half-trusted score (mirrors the leniency gate's nothing-half-trusted rule).

import { createHash } from 'node:crypto';

const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** JSON with recursively sorted keys — deterministic rendering of args/results. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Validate a rubric: { name, criteria: [{ name, weight, description }] }.
 * Weights must be numbers in [0, 1] summing to exactly 1 (within 1e-9).
 * Throws on any violation — a bad rubric is a bug, not a judgment call.
 */
export function validateRubric(rubric) {
  if (!rubric || typeof rubric.name !== 'string' || rubric.name.length === 0) {
    throw new Error('rubric needs a non-empty string name');
  }
  if (!Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
    throw new Error(`rubric "${rubric.name}" needs at least one criterion`);
  }
  const seen = new Set();
  let total = 0;
  for (const c of rubric.criteria) {
    if (!c || typeof c.name !== 'string' || c.name.length === 0) {
      throw new Error(`rubric "${rubric.name}" has a criterion without a name`);
    }
    if (seen.has(c.name)) throw new Error(`rubric "${rubric.name}" duplicates criterion "${c.name}"`);
    seen.add(c.name);
    if (typeof c.weight !== 'number' || Number.isNaN(c.weight) || c.weight < 0 || c.weight > 1) {
      throw new Error(`rubric "${rubric.name}" criterion "${c.name}": weight must be a number in [0, 1]`);
    }
    if (typeof c.description !== 'string') {
      throw new Error(`rubric "${rubric.name}" criterion "${c.name}" needs a string description`);
    }
    total += c.weight;
  }
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`rubric "${rubric.name}" weights must sum to 1, got ${total}`);
  }
  return rubric;
}

function renderTrajectory(outcome) {
  const steps = outcome?.trajectory ?? [];
  if (steps.length === 0) return '(no trajectory recorded)';
  return steps
    .map((step, i) => {
      const result = step?.result;
      const verdict = result?.ok ? 'ok' : `error: ${result?.error ?? 'unknown'}`;
      const receipt = result?.receipt ? ` receipt=${result.receipt}` : '';
      return `${i + 1}. tool=${step?.tool ?? '?'} args=${stableStringify(step?.args ?? {})} -> ${verdict}${receipt}`;
    })
    .join('\n');
}

/**
 * Deterministic judge prompt. Pure function of (rubric, task, outcome, seed):
 * fixed template, sorted-key JSON rendering, no timestamps, no RNG.
 */
export function buildJudgePrompt({ rubric, task, outcome, seed }) {
  validateRubric(rubric);
  if (!Number.isInteger(seed)) throw new Error('judge seed must be an integer');
  const criteria = rubric.criteria
    .map((c) => `- ${c.name} (weight ${c.weight}): ${c.description}`)
    .join('\n');
  const schemaKeys = rubric.criteria.map((c) => `"${c.name}": <0..1>`).join(', ');
  return [
    'You are an impartial judge scoring an agent\'s work on a single eval task.',
    'Score ONLY what the trajectory and final answer show. Do not invent missing steps.',
    `Scoring seed: ${seed}`,
    '',
    `# Rubric: ${rubric.name}`,
    criteria,
    '',
    '# Task',
    `id: ${task?.id ?? '?'}`,
    `solver: ${task?.solver ?? '?'}`,
    `notes: ${task?.notes ?? ''}`,
    '',
    '# Agent trajectory',
    renderTrajectory(outcome),
    '',
    '# Agent final answer',
    String(outcome?.finalAnswer ?? '(none)'),
    '',
    '# Required output',
    'Return exactly one JSON object and no other text:',
    `{"scores": {${schemaKeys}}, "rationale": "<one or two sentences>"}`,
    'Each score is a number in [0,1] for the named criterion. Every criterion must appear exactly once.',
  ].join('\n');
}

function extractJson(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('```')) {
    const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
    if (!match) throw new Error('malformed judgment: unbalanced code fence');
    return match[1];
  }
  return trimmed;
}

/**
 * Strict-parse a judgment against the rubric. Returns { criterionScores, rationale }.
 * Throws on: non-JSON, missing/extra criterion keys, out-of-range scores,
 * missing or empty rationale. Anything else is a malformed judgment.
 */
export function parseJudgment(text, rubric) {
  validateRubric(rubric);
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    throw new Error(`malformed judgment: not valid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed judgment: top level must be a JSON object');
  }
  const scores = parsed.scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw new Error('malformed judgment: "scores" must be an object');
  }
  const expected = rubric.criteria.map((c) => c.name);
  for (const name of expected) {
    if (!(name in scores)) throw new Error(`malformed judgment: missing score for criterion "${name}"`);
    const v = scores[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`malformed judgment: score for "${name}" must be a number in [0,1], got ${JSON.stringify(v)}`);
    }
  }
  for (const key of Object.keys(scores)) {
    if (!expected.includes(key)) throw new Error(`malformed judgment: unexpected criterion "${key}"`);
  }
  if (typeof parsed.rationale !== 'string' || parsed.rationale.trim().length === 0) {
    throw new Error('malformed judgment: "rationale" must be a non-empty string');
  }
  const criterionScores = Object.fromEntries(expected.map((name) => [name, scores[name]]));
  return { criterionScores, rationale: parsed.rationale.trim() };
}

/**
 * Build an LLM judge scorer.
 *
 * @param {object} rubric — validated by validateRubric.
 * @param {function} judgeFn — async ({ prompt, seed, attempt }) => string. The ONLY
 *   provider touchpoint; inject any transport (OpenAI, Anthropic, local model, stub).
 * @param {number} seed — integer, rendered into the prompt, passed to judgeFn, logged.
 *   Note: the seed makes the module's input deterministic; it cannot force a
 *   provider to honor seed semantics — see LIMITS above.
 * @param {number} maxRetries — malformed-judgment retries before failing closed.
 * @param {function} [logger] — optional (entry) => void, called per judgment attempt.
 * @returns {{ scorer, journal, rubric, seed }} — scorer is a drop-in runEval scorer
 *   (task, outcome) => number in [0, 1]; journal is the audit log (what was
 *   sent and received per attempt), not a score-reproduction guarantee.
 */
export function createLlmJudge({ rubric, judgeFn, seed = 0, maxRetries = 2, logger = null, name } = {}) {
  validateRubric(rubric);
  if (typeof judgeFn !== 'function') throw new Error('createLlmJudge needs a judgeFn transport');
  if (!Number.isInteger(seed)) throw new Error('judge seed must be an integer');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }
  if (logger !== null && typeof logger !== 'function') throw new Error('logger must be a function or null');

  const journal = [];
  const judgeName = name ?? rubric.name;

  const log = (entry) => {
    journal.push(entry);
    if (logger) logger(entry);
  };

  const scorer = async (task, outcome) => {
    const prompt = buildJudgePrompt({ rubric, task, outcome, seed });
    const promptHash = sha256hex(prompt);
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const raw = await judgeFn({ prompt, seed, attempt });
      const entry = {
        judge: judgeName,
        taskId: task?.id,
        seed,
        attempt,
        promptHash,
        judgmentHash: sha256hex(String(raw ?? '')),
      };
      try {
        const { criterionScores, rationale } = parseJudgment(raw, rubric);
        const score = rubric.criteria.reduce((sum, c) => sum + c.weight * criterionScores[c.name], 0);
        entry.score = score;
        entry.rationale = rationale;
        log(entry);
        return score;
      } catch (err) {
        entry.error = err.message;
        log(entry);
        lastError = err;
      }
    }
    throw new Error(
      `LLM judge "${judgeName}" produced malformed judgments for task ${task?.id} ` +
        `after ${maxRetries + 1} attempt(s): ${lastError?.message}`,
    );
  };

  return { scorer, journal, rubric, seed };
}

// Compatibility scorer for numeric injected transports. The structured, journaled
// createLlmJudge above remains the reproducible default. No model is called here.
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
    if (!record || typeof record.taskId !== 'string' || !record.taskId
      || !Number.isFinite(record.humanScore) || record.humanScore < 0 || record.humanScore > 1) {
      throw new Error('calibration records need taskId and a finite humanScore in [0,1]');
    }
    const judgeScore = normalizeScore(await judgeFn(record));
    const absErr = Math.abs(judgeScore - record.humanScore);
    perTask.push({ taskId: record.taskId, humanScore: record.humanScore, judgeScore, absErr });
  }
  const mae = perTask.reduce((sum, r) => sum + r.absErr, 0) / perTask.length;
  return { n: perTask.length, mae, perTask };
}
