import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { claimFollowThrough } from './experiments/claim-follow-through.mjs';

const head = 'a'.repeat(40);
const now = '2026-10-09T04:00:00.000Z';
const options = { now, candidateHead: head };
const claim = overrides => ({
  id: 'selected', state: 'in_progress', owner: 'accepted-owner',
  claimedAt: '2026-10-09T03:00:00.000Z', leaseExpiresAt: '2026-10-09T09:00:00.000Z',
  revision: null, ci: { state: 'success', headSha: head }, reviews: [], ...overrides,
});
const code = (item, opts = options) => claimFollowThrough(item, opts).nextAction.code;

test('invalid premises and superseded scope never become pickup recommendations', () => {
  assert.equal(code(claim({ state: 'unclaimed', owner: null, premiseFlag: { reason: 'disproved' } })), 'recheck_premise');
  assert.equal(code(claim({ supersededBy: 'replacement' })), 'inspect_successor');
});
test('missing, closed and invalidated dependencies remain unresolved', () => {
  const item = claim({ dependsOn: ['dependency'] });
  for (const dependencies of [[], [{ id: 'dependency', state: 'closed' }],
    [{ id: 'dependency', state: 'done', premiseFlag: { reason: 'disproved' } }]]) {
    assert.equal(code(item, { ...options, dependencies }), 'inspect_dependencies');
  }
  assert.equal(code(item, { ...options, dependencies: [{ id: 'dependency', state: 'done' }] }), 'inspect_acceptance');
});
test('pending and failing executions help the accepted owner without dispatch', () => {
  assert.equal(code(claim({ ci: { state: 'pending', headSha: head } })), 'await_evidence');
  assert.equal(code(claim({ ci: { state: 'failure', headSha: head } })), 'inspect_failure');
  assert.equal(claimFollowThrough(claim(), options).basis.owner, 'accepted-owner');
});
test('approval is stale when candidate, claim round, owner or revision changes', () => {
  const basis = { version: 1, owner: 'accepted-owner', claimedAt: claim().claimedAt, revision: null, headSha: head };
  const reviewed = claim({ reviews: [{ verdict: 'approve', basis }] });
  assert.equal(claimFollowThrough(reviewed, options).currentReviewCount, 1);
  for (const change of [{ owner: 'next-owner' }, { claimedAt: now }, { revision: 'b'.repeat(40) }]) {
    assert.equal(claimFollowThrough({ ...reviewed, ...change }, options).staleReviewCount, 1);
  }
  const newer = claimFollowThrough(reviewed, { ...options, candidateHead: 'b'.repeat(40) });
  assert.equal(newer.currentReviewCount, 0);
  assert.equal(newer.nextAction.code, 'refresh_head_evidence');
});
test('lease uncertainty, explicit holds and unaccepted work require different continuations', () => {
  assert.equal(code(claim({ leaseExpiresAt: now })), 'refresh_lease');
  assert.equal(code(claim({ leaseExpiresAt: null })), 'refresh_lease');
  assert.equal(code(claim({ state: 'blocked' })), 'inspect_hold');
  assert.equal(code(claim({ state: 'unclaimed', owner: null })), 'dispatcher_acceptance');
});
test('merged delivery and successful CI do not imply deployment or executed acceptance', () => {
  const result = claimFollowThrough(claim({ state: 'done', deliveryMode: 'merged' }), options);
  assert.equal(result.deliveryMode, 'merged');
  assert.equal(result.nextAction.code, 'inspect_delivery');
  assert.equal(code(claim()), 'inspect_acceptance');
});
test('helper is read-only and requires explicit observation and valid inputs', () => {
  const item = claim();
  const before = structuredClone(item);
  assert.equal(claimFollowThrough(item, options).writes, false);
  assert.deepEqual(item, before);
  assert.throws(() => claimFollowThrough(item), /timestamp/);
  assert.throws(() => claimFollowThrough(item, { now, candidateHead: 'short' }), /head/);
  assert.throws(() => claimFollowThrough({ id: 'x', state: 'invented' }, options), /valid/);
});
test('offline CLI reconstructs the same result and rejects unused arguments', () => {
  const args = ['tests/experiments/claim-follow-through.mjs'];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const input = JSON.stringify({ claim: claim(), options });
  const run = spawnSync(process.execPath, args, { input, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), claimFollowThrough(claim(), options));
  assert.notEqual(spawnSync(process.execPath, [...args, '--dispatch'], { input, env }).status, 0);
});

test('current review findings prompt assessment without inventing a merge hold', () => {
  const item = claim({ reviews: [{ verdict: 'changes_requested', basis: {
    version: 1, owner: 'accepted-owner', claimedAt: claim().claimedAt, revision: null, headSha: head,
  } }] });
  assert.equal(code(item), 'inspect_review_findings');
  assert.equal(code({ ...item, reviews: [{ ...item.reviews[0], basis: { ...item.reviews[0].basis, headSha: 'b'.repeat(40) } }] }), 'inspect_acceptance');
});

test('test discovery never starts the stdin CLI', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', 'tests/experiments/claim-follow-through.mjs'], { encoding: 'utf8', timeout: 5000, env });
  assert.equal(run.status, 0, run.stderr);
});
