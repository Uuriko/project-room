// evals/ harness skeleton — failing-first contract tests (QA2 BUILD-EVALS).
// These fail before the harness exists and pass after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evalsDir = path.join(root, 'evals');

test('harness modules exist and load', async () => {
  const { runEval, loadJsonl } = await import('../evals/index.mjs');
  assert.equal(typeof runEval, 'function');
  assert.equal(typeof loadJsonl, 'function');
  const rows = await loadJsonl(path.join(evalsDir, 'datasets/tasks/work-claim-journey.jsonl'));
  assert.ok(rows.length >= 2, 'expected at least 2 pinned tasks');
  assert.ok(rows.every(r => r.id && r.solver), 'each task pins id + solver');
});

test('example eval: join→claim→finish journey passes deterministic scorer', async () => {
  const { runEval, loadJsonl } = await import('../evals/index.mjs');
  const { solveJoinClaimFinish } = await import('../evals/solvers/join-claim-finish.mjs');
  const { scoreClaimJourney } = await import('../evals/scorers/deterministic.mjs');
  const tasks = await loadJsonl(path.join(evalsDir, 'datasets/tasks/work-claim-journey.jsonl'));
  const report = await runEval({
    tasks,
    solver: (task) => solveJoinClaimFinish(task),
    scorers: { claimJourney: scoreClaimJourney },
  });
  assert.equal(report.summary.total, tasks.length);
  assert.equal(report.summary.failed, 0, JSON.stringify(report.results, null, 1));
  assert.ok(report.results.every(r => r.scores.claimJourney === 1),
    'every task scores 1.0 deterministically');
});

test('example eval: mcp tools/list→call journey passes deterministic scorer', async () => {
  const { runEval, loadJsonl } = await import('../evals/index.mjs');
  const { solveMcpListCall } = await import('../evals/solvers/mcp-tools-list-call.mjs');
  const { scoreMcpJourney } = await import('../evals/scorers/deterministic.mjs');
  const tasks = await loadJsonl(path.join(evalsDir, 'datasets/tasks/mcp-tools-journey.jsonl'));
  const report = await runEval({
    tasks,
    solver: (task) => solveMcpListCall(task),
    scorers: { mcpJourney: scoreMcpJourney },
  });
  assert.equal(report.summary.failed, 0, JSON.stringify(report.results, null, 1));
  assert.ok(report.results.every(r => r.scores.mcpJourney === 1));
});

test('judge-leniency gate blocks |leniency| > 0.25', async () => {
  const { computeLeniency, leniencyGate } = await import('../evals/scorers/judge-leniency.mjs');
  // Judge systematically 0.5 generous vs human reference (binary-exact).
  const biased = Array.from({ length: 6 }, (_, i) => ({
    taskId: `cal-${i}`, humanScore: 0.5, judgeScore: 1.0,
  }));
  assert.equal(computeLeniency(biased), 0.5);
  const gate = leniencyGate(biased);
  assert.equal(gate.pass, false, 'biased judge must not be trusted');
  assert.ok(Math.abs(gate.leniency) > 0.25);

  // Unbiased judge passes (diffs cancel to exactly 0, binary-exact).
  const fair = Array.from({ length: 6 }, (_, i) => ({
    taskId: `cal-${i}`, humanScore: 0.5, judgeScore: i % 2 ? 0.75 : 0.25,
  }));
  assert.equal(leniencyGate(fair).pass, true);
});

test('shipped calibration set is within the leniency bound', async () => {
  const { loadJsonl } = await import('../evals/index.mjs');
  const { computeLeniency, leniencyGate } = await import('../evals/scorers/judge-leniency.mjs');
  const rows = await loadJsonl(path.join(evalsDir, 'calibration/judge-calibration-set.jsonl'));
  assert.ok(rows.length >= 5, 'calibration set must be non-trivial');
  assert.ok(rows.every(r => typeof r.humanScore === 'number' && typeof r.judgeScore === 'number'));
  const gate = leniencyGate(rows);
  assert.equal(gate.pass, true, `shipped calibration set must pass the gate, leniency=${computeLeniency(rows)}`);
});

test('EVALUATION_CHECKLIST.md requires held-out validation run + trajectory review', () => {
  const md = readFileSync(path.join(evalsDir, 'EVALUATION_CHECKLIST.md'), 'utf8');
  assert.match(md, /held-out/i, 'must require a held-out validation run');
  assert.match(md, /trajectory/i, 'must require trajectory review');
  assert.match(md, /leniency/i, 'must reference the judge-leniency gate');
});

// --- Crew C6: runEval edge-case hardening ---------------------------------
// Each test guards one documented runEval contract. The solver-throw and
// duplicate-id tests are regression tests: they fail on the pre-fix harness,
// which propagated bare solver errors and silently accepted duplicate ids.
// The other three pin existing behavior as the documented contract.

test('runEval: solver throwing mid-run aborts with an error naming the task id', async () => {
  const { runEval } = await import('../evals/index.mjs');
  let t2Ran = false;
  let err;
  try {
    await runEval({
      tasks: [{ id: 't-bad' }, { id: 't-ok' }],
      solver: (task) => {
        if (task.id === 't-bad') throw new Error('boom');
        t2Ran = true;
        return {};
      },
      scorers: {},
    });
  } catch (e) { err = e; }
  assert.ok(err, 'runEval must reject when the solver throws');
  assert.match(err.message, /solver failed for task "t-bad"/,
    'error must name the failing task id, not surface a bare stack');
  assert.match(err.message, /boom/, 'original solver reason must survive');
  assert.equal(t2Ran, false, 'runEval must abort, not continue to the next task');
});

test('runEval: fractional scorer scores are recorded exactly; pass needs every scorer exactly 1', async () => {
  const { runEval } = await import('../evals/index.mjs');
  const report = await runEval({
    tasks: [{ id: 't1' }, { id: 't2' }],
    solver: () => ({}),
    scorers: { s: (task) => (task.id === 't2' ? 0.5 : 1) },
  });
  const [r1, r2] = report.results;
  assert.equal(r1.scores.s, 1);
  assert.equal(r1.passed, true);
  assert.equal(r2.scores.s, 0.5, 'fractional score must be recorded exactly');
  assert.equal(r2.passed, false, 'deterministic-first: 0.5 is not a pass');
  assert.deepEqual(report.summary, { total: 2, passed: 1, failed: 1 });
});

test('runEval: outcome missing trajectory defaults to []', async () => {
  const { runEval } = await import('../evals/index.mjs');
  const report = await runEval({
    tasks: [{ id: 't1' }, { id: 't2' }],
    solver: (task) => (task.id === 't1' ? { finalAnswer: 'x' } : { trajectory: ['step'] }),
    scorers: {},
  });
  assert.deepEqual(report.results[0].trajectory, []);
  assert.deepEqual(report.results[1].trajectory, ['step'], 'present trajectory must survive');
});

test('runEval: duplicate task ids throw a clear error before running anything', async () => {
  const { runEval } = await import('../evals/index.mjs');
  let ran = false;
  await assert.rejects(
    runEval({
      tasks: [{ id: 'dup' }, { id: 'dup' }],
      solver: () => { ran = true; return {}; },
      scorers: {},
    }),
    /duplicate task id "dup"/,
    'error must name the duplicated id'
  );
  assert.equal(ran, false, 'no task may run before the duplicate check');
});

test('runEval: empty scorers object means every task passes (vacuous pass, documented)', async () => {
  const { runEval } = await import('../evals/index.mjs');
  const report = await runEval({
    tasks: [{ id: 't1' }, { id: 't2' }],
    solver: () => ({}),
    scorers: {},
  });
  assert.ok(report.results.every((r) => r.passed === true));
  assert.deepEqual(report.summary, { total: 2, passed: 2, failed: 0 });
});
