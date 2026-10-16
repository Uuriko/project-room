import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHOPPER_STEPS, buildShopperReport, summarizeShopperReport, validateShopperReport } from '../scripts/shopper-report.mjs';
import { excerptOf, selectClaimTarget } from '../scripts/mystery-shopper.mjs';

// The committed sample is a real runner output against a seeded fixture
// room (see the shopper-feature design issue): keeping it valid here keeps
// the sample honest as the schema evolves.
const sample = JSON.parse(readFileSync(new URL('./fixtures/shopper-report.sample.json', import.meta.url), 'utf8'));

test('the committed sample report validates and completed its loop', () => {
  assert.equal(validateShopperReport(sample), sample);
  const summary = summarizeShopperReport(sample);
  assert.equal(summary.outcome, 'completed-loop');
  assert.equal(summary.worstSeverity, 'none');
  assert.match(summary.receiptId, /^pwr_[0-9a-f]{64}$/);
  assert.equal(sample.scope.realTasksObservedNotAttempted, 1);
});

test('the sample report carries no credential material', () => {
  const text = JSON.stringify(sample);
  assert.doesNotMatch(text, /pri_[A-Za-z0-9_-]{6,}/);
  assert.match(text, /<redacted>/);
});

const call = (method, path, status = 200) => ({ method, path, status, ms: 5, responseSha256: 'a'.repeat(64), excerpt: '{}' });
const step = (id, status, severity, calls = []) => ({ step: id, status, severity, expected: SHOPPER_STEPS[id], observed: `${id} observed`, calls });
const run = steps => buildShopperReport({
  generatedAt: '2026-10-15T00:00:00.000Z',
  summon: { summonId: 'sum_test', roomId: 'fixture-room', requestedBy: 'owner' },
  shopper: { identityId: 'ai_test', displayName: 'Mystery Shopper', provenance: 'platform-shopper/1', mode: 'public-door-only' },
  scope: { origin: 'http://127.0.0.1:1', namespaceId: 'public_x', testTaskIds: ['shopper-test:a'], realTasksObservedNotAttempted: 0 },
  steps });

test('friction is derived from steps and a shared call is counted once', () => {
  const board = call('GET', '/api/public-work/tasks?limit=100');
  const report = run([step('list-board', 'ok', 'none', [board]), step('scope-board', 'blocked', 'blocking', [board])]);
  assert.equal(report.outcome, 'blocked');
  assert.equal(report.totals.calls, 1);
  assert.equal(report.totals.blocking, 1);
  assert.deepEqual(report.friction, [{ step: 'scope-board', severity: 'blocking', summary: 'scope-board observed', evidenceCallIndexes: [0] }]);
});

test('a run with friction but no blockage is partial, never completed', () => {
  const report = run([step('match', 'friction', 'minor', [call('POST', '/api/public-work/match')])]);
  assert.equal(report.outcome, 'partial');
  assert.equal(report.receiptId, null);
});

test('validation rejects severity/status disagreement and unknown steps', () => {
  assert.throws(() => run([step('list-board', 'ok', 'major', [])]), /severity\/status disagree/);
  const forged = run([step('list-board', 'ok', 'none', [])]);
  forged.steps[0].step = 'teleport-into-room';
  assert.throws(() => validateShopperReport(forged), /not in the shopper taxonomy/);
});

test('evidence calls carry exactly the schema keys — a raw body has nowhere to hide', () => {
  const leaky = call('POST', '/api/agent-identities', 201);
  leaky.text = '{"secret":"pri_must_never_ship"}';
  assert.throws(() => run([step('mint-identity', 'ok', 'none', [leaky])]), /exactly method, path, status, ms, responseSha256/);
});

test('selectClaimTarget only ever selects a marked, claimable, in-namespace test task', () => {
  const scope = { namespaceId: 'public_room', testTaskIds: ['shopper-test:a', 'shopper-test:b'] };
  const task = (taskId, claimable, namespaceId = 'public_room') => ({ taskId, claimable, namespaceId });
  assert.equal(selectClaimTarget([task('real:x', true), task('shopper-test:a', true)], scope).taskId, 'shopper-test:a');
  assert.equal(selectClaimTarget([task('real:x', true)], scope), null);
  assert.equal(selectClaimTarget([task('shopper-test:a', false), task('shopper-test:b', true)], scope).taskId, 'shopper-test:b');
  assert.equal(selectClaimTarget([task('shopper-test:a', true, 'public_other')], scope), null);
});

test('excerpts redact secret-bearing fields before they can reach a report', () => {
  const excerpt = excerptOf(JSON.stringify({ identityId: 'ai_x', secret: 'pri_leakme', nested: { privateKey: 'leak' } }));
  assert.doesNotMatch(excerpt, /pri_leakme|leak/);
  assert.match(excerpt, /<redacted>/);
});
