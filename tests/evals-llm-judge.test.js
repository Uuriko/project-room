// LLM-judge scoring module tests (failing-first: the module does not exist yet).
// Contract under test: rubric-based scoring with structured output, deterministic
// prompts, retry on malformed judgments, provider-swappable transport, seeded + logged.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLlmJudge,
  buildJudgePrompt,
  parseJudgment,
  validateRubric,
} from '../evals/scorers/llm-judge.mjs';

const RUBRIC = {
  name: 'claim-journey-quality',
  criteria: [
    { name: 'tool_order', weight: 0.5, description: 'tools called in the expected order' },
    { name: 'receipt', weight: 0.5, description: 'finish minted a valid receipt' },
  ],
};

const GOOD_OUTCOME = {
  trajectory: [
    { tool: 'room.join', args: {}, result: { ok: true } },
    { tool: 'room.claim', args: { id: 'w1' }, result: { ok: true } },
    { tool: 'room.claim', args: { id: 'w1' }, result: { ok: false, error: 'already-claimed' } },
    { tool: 'room.finish', args: { id: 'w1' }, result: { ok: true, receipt: 'rcpt_GOOD' } },
  ],
  finalAnswer: 'claimed and finished with receipt rcpt_GOOD',
};

const BAD_OUTCOME = {
  trajectory: [
    { tool: 'room.join', args: {}, result: { ok: true } },
    { tool: 'room.finish', args: { id: 'w1' }, result: { ok: false, error: 'no-lease' } },
  ],
  finalAnswer: 'finished without a lease, no receipt',
};

const TASK = { id: 'wcj-01', solver: 'join-claim-finish', notes: 'claim journey' };

// A swappable judge transport: decides purely from the rendered prompt so the
// discrimination proof tests the module's prompt fidelity, not the stub's taste.
const discriminatingJudge = async ({ prompt }) =>
  JSON.stringify({
    scores: {
      tool_order: prompt.includes('rcpt_GOOD') ? 1 : 0,
      receipt: prompt.includes('rcpt_GOOD') ? 1 : 0,
    },
    rationale: prompt.includes('rcpt_GOOD') ? 'all criteria met' : 'no criterion met',
  });

test('judge discriminates a known-good from a known-bad output', async () => {
  const { scorer } = createLlmJudge({ rubric: RUBRIC, judgeFn: discriminatingJudge, seed: 7 });
  const good = await scorer(TASK, GOOD_OUTCOME);
  const bad = await scorer(TASK, BAD_OUTCOME);
  assert.equal(good, 1);
  assert.equal(bad, 0);
  assert.ok(good > bad, 'known-good must score strictly above known-bad');
});

test('prompt is deterministic for identical inputs; seed changes it', () => {
  const a = buildJudgePrompt({ rubric: RUBRIC, task: TASK, outcome: GOOD_OUTCOME, seed: 7 });
  const b = buildJudgePrompt({ rubric: RUBRIC, task: TASK, outcome: GOOD_OUTCOME, seed: 7 });
  const c = buildJudgePrompt({ rubric: RUBRIC, task: TASK, outcome: GOOD_OUTCOME, seed: 8 });
  assert.equal(a, b, 'identical inputs must render an identical prompt');
  assert.notEqual(a, c, 'the seed must be part of the prompt');
  assert.ok(a.includes('Scoring seed: 7'), 'prompt must carry the seed verbatim');
});

test('retry recovers from one malformed judgment; journal logs every attempt', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return 'this is not json at all';
    return JSON.stringify({ scores: { tool_order: 1, receipt: 1 }, rationale: 'recovered' });
  };
  const { scorer, journal } = createLlmJudge({ rubric: RUBRIC, judgeFn: flaky, seed: 3, maxRetries: 2 });
  const score = await scorer(TASK, GOOD_OUTCOME);
  assert.equal(score, 1);
  assert.equal(journal.length, 2, 'both attempts must be logged');
  assert.equal(journal[0].error != null, true, 'first attempt must record the parse error');
  assert.equal(journal[0].promptHash, journal[1].promptHash, 'retry re-uses the same prompt');
  assert.equal(journal[1].score, 1);
  assert.ok(journal.every((e) => e.taskId === 'wcj-01' && e.seed === 3), 'log carries task id and seed');
});

test('persistent malformed judgments fail closed after maxRetries', async () => {
  const broken = async () => 'garbage {{{';
  const { scorer } = createLlmJudge({ rubric: RUBRIC, judgeFn: broken, seed: 1, maxRetries: 1 });
  await assert.rejects(() => scorer(TASK, GOOD_OUTCOME), /malformed/i);
});

test('rubric weights must sum to 1', () => {
  assert.throws(
    () =>
      createLlmJudge({
        rubric: {
          name: 'bad',
          criteria: [
            { name: 'a', weight: 0.6, description: 'x' },
            { name: 'b', weight: 0.6, description: 'y' },
          ],
        },
        judgeFn: discriminatingJudge,
      }),
    /weights must sum to 1/i,
  );
  assert.doesNotThrow(() => validateRubric(RUBRIC));
});

test('judgment missing a criterion key is malformed', () => {
  assert.throws(
    () => parseJudgment(JSON.stringify({ scores: { tool_order: 1 }, rationale: 'partial' }), RUBRIC),
    /receipt/i,
  );
});

test('judgment scores outside [0, 1] are malformed', () => {
  assert.throws(
    () =>
      parseJudgment(
        JSON.stringify({ scores: { tool_order: 2, receipt: 0 }, rationale: 'out of range' }),
        RUBRIC,
      ),
    /\[0,1\]/,
  );
});

test('scorer works as a drop-in runEval scorer', async () => {
  const { runEval } = await import('../evals/index.mjs');
  const { scorer } = createLlmJudge({ rubric: RUBRIC, judgeFn: discriminatingJudge, seed: 7 });
  const solver = async (task) => (task.id === 'good' ? GOOD_OUTCOME : BAD_OUTCOME);
  const report = await runEval({
    tasks: [
      { id: 'good', solver: 'x' },
      { id: 'bad', solver: 'x' },
    ],
    solver,
    scorers: { judge: scorer },
  });
  const byId = Object.fromEntries(report.results.map((r) => [r.taskId, r.scores.judge]));
  assert.equal(byId.good, 1);
  assert.equal(byId.bad, 0);
});
