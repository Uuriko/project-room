// Contract (Q-1): the quarantine trigger PROPOSES entries only from
// same-head flake evidence with a named failing test. It never proposes
// from a silent runner death, a timeout cancel, or a real (everywhere)
// failure, and never writes tests/quarantine.json itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSignatures, classifyEvent, buildProposals, parseJunitFailures,
  evidenceFromArtefact, addDaysISO, pickArtefact,
} from '../scripts/quarantine-trigger.mjs';
import { zipSyncFixture } from './fixtures/quarantine-trigger/zip-fixture.mjs';

const SHA = 'a'.repeat(40);
function run(over = {}) {
  return {
    id: 1, status: 'completed', conclusion: 'success', run_attempt: 1,
    head_sha: SHA, head_branch: 'main', created_at: '2026-10-18T00:00:00Z',
    ...over,
  };
}
function job(over = {}) {
  return {
    name: 'unit shard 1/3', run_attempt: 1, conclusion: 'success',
    started_at: '2026-10-18T00:00:00Z', completed_at: '2026-10-18T00:05:00Z',
    steps: [{ name: 'Run unit shard', conclusion: 'success' }],
    ...over,
  };
}
const failJob = (over = {}) => job({
  conclusion: 'failure',
  steps: [{ name: 'Run unit shard', conclusion: 'failure' }],
  ...over,
});

test('rerun flip: attempt-1 failure -> final success at the same head is a signature', () => {
  const r = run({ id: 10, run_attempt: 2 });
  const jobs = new Map([[10, [
    failJob({ run_attempt: 1 }), job({ run_attempt: 2 }),
    job({ name: 'unit shard 2/3', run_attempt: 1 }),
    job({ name: 'unit shard 2/3', run_attempt: 2 }),
  ]]]);
  const events = detectSignatures([r], jobs);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'rerun-flip');
  assert.equal(events[0].jobName, 'unit shard 1/3');
  assert.equal(events[0].failingAttempt, 1);
});

test('a job failing in every attempt emits no event (real failure, not flake)', () => {
  const r = run({ id: 11, run_attempt: 2, conclusion: 'failure' });
  const jobs = new Map([[11, [failJob({ run_attempt: 1 }), failJob({ run_attempt: 2 })]]]);
  assert.equal(detectSignatures([r], jobs).length, 0);
});

test('same-SHA divergence: failing run + passing run at one SHA is a signature', () => {
  const f = run({ id: 20, conclusion: 'failure' });
  const s = run({ id: 21, conclusion: 'success' });
  const jobs = new Map([[20, [failJob()]], [21, [job()]]]);
  const events = detectSignatures([f, s], jobs);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'same-sha-divergence');
  assert.deepEqual(events[0].evidenceRunIds, [20, 21]);
});

test('same-SHA failure where the job failed in the passing run too emits nothing', () => {
  // The "passing" run succeeded overall only because the shard was skipped /
  // the job never passed: no divergence for this job.
  const f = run({ id: 22, conclusion: 'failure' });
  const s = run({ id: 23, conclusion: 'success' });
  const jobs = new Map([[22, [failJob()]], [23, [job({ conclusion: 'skipped' })]]]);
  assert.equal(detectSignatures([f, s], jobs).length, 0);
});

test('superseded (cancelled) runs are ignored entirely', () => {
  const c = run({ id: 24, conclusion: 'cancelled', run_attempt: 2 });
  const jobs = new Map([[24, [failJob({ run_attempt: 1 }), job({ run_attempt: 2 })]]]);
  assert.equal(detectSignatures([c], jobs).length, 0);
});

test('timeout cancel that passes on re-run is a signature but never a proposed entry', () => {
  const r = run({ id: 12, run_attempt: 2 });
  const jobs = new Map([[12, [
    job({ conclusion: 'cancelled', run_attempt: 1,
      started_at: '2026-10-18T00:00:00Z', completed_at: '2026-10-18T00:15:18Z' }),
    job({ run_attempt: 2 }),
  ]]]);
  const events = detectSignatures([r], jobs);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'timeout-flip');
  const c = classifyEvent(events[0], { receiptPresent: true, receiptFailures: [], junitFailures: [] });
  assert.equal(c.status, 'needs-naming');
  assert.deepEqual(c.tests, []);
});

test('silent runner death is excluded: failed job, evidence names no test', () => {
  const ev = { kind: 'rerun-flip', failingJob: failJob() };
  const c = classifyEvent(ev, { receiptPresent: true, receiptFailures: [], junitFailures: [] });
  assert.equal(c.status, 'excluded-runner-death');
});

test('silent runner death is excluded even with receipt names when no step failed', () => {
  const ev = { kind: 'rerun-flip', failingJob: job({ conclusion: 'failure', steps: [{ name: 'x', conclusion: 'success' }] }) };
  const c = classifyEvent(ev, {
    receiptPresent: true, receiptFailures: ['some test'],
    junitFailures: [{ file: 'tests/x.test.js', name: 'some test' }],
  });
  assert.equal(c.status, 'excluded-runner-death');
});

test('named junit failure at the same head classifies as proposed, file > name', () => {
  const ev = { kind: 'rerun-flip', failingJob: failJob() };
  const c = classifyEvent(ev, {
    receiptPresent: true, receiptFailures: ['flaky thing'],
    junitFailures: [{ file: 'tests/flaky.test.js', name: 'flaky thing' }],
  });
  assert.equal(c.status, 'proposed');
  assert.deepEqual(c.tests, ['tests/flaky.test.js > flaky thing']);
});

test('missing artefact stays needs-naming, never proposed', () => {
  const ev = { kind: 'same-sha-divergence', failingJob: failJob() };
  assert.equal(classifyEvent(ev, null).status, 'needs-naming');
});

test('parseJunitFailures reads file + name only from failing testcases', () => {
  const xml = `<testsuites><testsuite name="tests/a.test.js">
    <testcase name="passes" file="tests/a.test.js" time="0.1"/>
    <testcase name="flakes" file="tests/a.test.js" time="0.2"><failure message="x"/></testcase>
    </testsuite></testsuites>`;
  assert.deepEqual(parseJunitFailures(xml), [{ file: 'tests/a.test.js', name: 'flakes' }]);
});

test('evidenceFromArtefact reads receipt failures and junit from a zip', () => {
  const zip = zipSyncFixture({
    'unit-shard-1-of-3-attempt-1.json': JSON.stringify({ failures: ['flakes'] }),
    'unit-junit-1-of-3-attempt-1.xml':
      '<testsuites><testsuite name="s"><testcase name="flakes" file="tests/a.test.js"><failure/></testcase></testsuite></testsuites>',
  });
  const ev = evidenceFromArtefact(zip);
  assert.equal(ev.receiptPresent, true);
  assert.deepEqual(ev.receiptFailures, ['flakes']);
  assert.deepEqual(ev.junitFailures, [{ file: 'tests/a.test.js', name: 'flakes' }]);
});

test('aggregator jobs never emit events (they fail because a shard failed)', () => {
  const r = run({ id: 13, run_attempt: 2 });
  const jobs = new Map([[13, [
    failJob({ name: 'unit', run_attempt: 1 }), job({ name: 'unit', run_attempt: 2 }),
    failJob({ name: 'test', run_attempt: 1 }), job({ name: 'test', run_attempt: 2 }),
  ]]]);
  assert.equal(detectSignatures([r], jobs).length, 0);
});

test('parseJunitFailures survives a literal ">" inside an attribute value', () => {
  // Node junit leaves ">" unescaped in failure attributes — the exact shape
  // of the soak-leak flake ("lag p99 361 ms > 250 ms threshold").
  const xml = `<testsuites><testsuite name="test">
    <testcase name="soak harness PASSES" time="35.5" classname="test" file="/home/runner/work/project-room/project-room/tests/soak-leak-detection.test.js" failure="lag p99 361 ms > 250 ms threshold">
      <failure type="testCodeFailure" message="x">boom</failure>
    </testcase></testsuite></testsuites>`;
  assert.deepEqual(parseJunitFailures(xml), [
    { file: 'tests/soak-leak-detection.test.js', name: 'soak harness PASSES' },
  ]);
});

test('a file-level failure (testcase name == its file) proposes the bare file', () => {
  const ev = { kind: 'same-sha-divergence', failingJob: failJob() };
  const c = classifyEvent(ev, {
    receiptPresent: true, receiptFailures: ['tests/shed-loop-attention.test.js'],
    junitFailures: [{ file: 'tests/shed-loop-attention.test.js', name: 'tests/shed-loop-attention.test.js' }],
  });
  assert.equal(c.status, 'proposed');
  assert.deepEqual(c.tests, ['tests/shed-loop-attention.test.js']);
});

test('pickArtefact selects the artefact of the job suite, not any evidence artefact', () => {
  const arts = [
    { name: 'conversation-browser-evidence-1-attempt-1' },
    { name: 'unit-shard-evidence-1-attempt-1' },
    { name: 'unit-shard-evidence-1-attempt-2' },
  ];
  assert.equal(pickArtefact(arts, 'unit shard 1/3', 1).name, 'unit-shard-evidence-1-attempt-1');
  assert.equal(pickArtefact(arts, 'browser shard 1/6', 1).name, 'conversation-browser-evidence-1-attempt-1');
});

test('buildProposals: suggested entry carries evidence, entry date, repair_by = +14d', () => {
  const proposals = buildProposals([{
    event: {
      kind: 'rerun-flip', runId: 10, headSha: SHA, branch: 'main',
      jobName: 'unit shard 1/3', failingAttempt: 1, evidenceRunIds: [10],
    },
    status: 'proposed', tests: ['tests/a.test.js > flakes'], classificationReason: 'x',
  }], { today: '2026-10-18', windowHours: 48, repo: 'Uuriko/project-room', workflow: 'test.yml' });
  assert.equal(proposals.candidates.length, 1);
  const entry = proposals.candidates[0].suggested_entry;
  assert.equal(entry.test, 'tests/a.test.js > flakes');
  assert.equal(entry.quarantined_at, '2026-10-18');
  assert.equal(entry.repair_by, '2026-11-01');
  assert.deepEqual(entry.evidence, ['https://github.com/Uuriko/project-room/actions/runs/10']);
  assert.equal(addDaysISO('2026-10-18', 14), '2026-11-01');
});

test('buildProposals never re-proposes an already-quarantined test', () => {
  const proposals = buildProposals([{
    event: {
      kind: 'rerun-flip', runId: 10, headSha: SHA, branch: 'main',
      jobName: 'unit shard 1/3', failingAttempt: 1, evidenceRunIds: [10],
    },
    status: 'proposed', tests: ['tests/a.test.js > flakes'], classificationReason: 'x',
  }], {
    today: '2026-10-18', windowHours: 48, repo: 'Uuriko/project-room',
    workflow: 'test.yml',
    existing: { quarantined: [{ test: 'tests/a.test.js > flakes' }] },
  });
  assert.equal(proposals.candidates.length, 0);
});
