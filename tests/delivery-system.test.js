import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeliveryJournal, repositoryResource } from '../delivery/journal.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-'));
  let time = 1000;
  const handles = [];
  const open = () => {
    const db = new DatabaseSync(join(directory, 'journal.sqlite'));
    handles.push(db);
    const journal = new DeliveryJournal(db, { now: () => time, transaction: fn => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } });
    journal.initialize();
    return { journal, db };
  };
  t.after(() => { for (const db of handles) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, advance: milliseconds => { time += milliseconds; } };
}

test('repository authority is shared across Rooms and preserves case-sensitive refs', () => {
  const input = { installation: '123', repository: 'Uuriko/project-room', ref: 'main' };
  assert.equal(repositoryResource(input), repositoryResource({ ...input, repository: 'uuriko/PROJECT-room' }));
  assert.notEqual(repositoryResource(input), repositoryResource({ ...input, ref: 'Main' }));
  assert.notEqual(repositoryResource(input), repositoryResource({ ...input, installation: '456' }));
});

test('independent connections exclude competing owners and fence expired owners', t => {
  const f = fixture(t), a = f.open().journal, b = f.open().journal;
  const lease = a.acquire('repo', 'room-a', 100);
  assert.equal(b.acquire('repo', 'room-b', 100), null);
  a.write(lease, 'pr:1', 0, { head: 'a' });
  f.advance(100);
  const next = b.acquire('repo', 'room-b', 100);
  assert.equal(next.generation, 2);
  assert.throws(() => a.write(lease, 'pr:1', 1, {}), /Stale/);
  assert.throws(() => a.renew(lease, 100), /Stale/);
  assert.throws(() => a.release(lease), /Stale/);
  assert.equal(b.write(next, 'pr:1', 1, { head: 'b' }).revision, 2);
  assert.throws(() => b.write(next, 'pr:1', 1, {}), /revision conflict/);
  b.release(next);
  assert.equal(a.acquire('repo', 'room-a', 100).generation, 3);
});

test('record writes cannot cross repository boundaries', t => {
  const journal = fixture(t).open().journal;
  const a = journal.acquire('repo-a', 'worker', 100), b = journal.acquire('repo-b', 'worker', 100);
  journal.write(a, 'item', 0, { resource: 'repo-b' });
  assert.throws(() => journal.write(b, 'item', 1, {}), /resource mismatch/);
  assert.equal(journal.read('item').value.resource, 'repo-a');
});

test('restart preserves uncertain dispatch; a successor cannot blindly redispatch', t => {
  const f = fixture(t), a = f.open().journal;
  const lease = a.acquire('repo', 'worker-a', 100);
  a.prepare(lease, 'merge:1', { head: 'a', base: 'b' });
  a.dispatch(lease, 'merge:1');
  f.advance(101);
  const b = f.open().journal, successor = b.acquire('repo', 'worker-b', 100);
  assert.equal(b.prepare(successor, 'merge:1', { head: 'a', base: 'b' }).state, 'unknown');
  assert.throws(() => b.dispatch(successor, 'merge:1'), /not dispatchable/);
  assert.throws(() => a.resolve(lease, 'merge:1', {}), /Stale/);
  assert.equal(b.resolve(successor, 'merge:1', { providerReceipt: 'merged:a' }).state, 'resolved');
  assert.equal(f.open().journal.effect('merge:1').result.providerReceipt, 'merged:a');
  assert.throws(() => b.prepare(successor, 'merge:1', { head: 'changed' }), /identity conflict/);
});

test('inbox deduplicates across connections and rejects reused IDs with different bodies', t => {
  const f = fixture(t), a = f.open().journal, b = f.open().journal;
  assert.equal(a.receive('github:delivery-1', { action: 'completed' }), true);
  assert.equal(b.receive('github:delivery-1', { action: 'completed' }), false);
  assert.throws(() => b.receive('github:delivery-1', { action: 'cancelled' }), /identity conflict/);
});

test('audit failure rolls back the business mutation', t => {
  const { journal, db } = fixture(t).open();
  const lease = journal.acquire('repo', 'worker', 100);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON delivery_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  assert.throws(() => journal.write(lease, 'item', 0, {}), /audit unavailable/);
  assert.equal(journal.read('item'), null);
  assert.throws(() => journal.prepare(lease, 'dispatch', {}), /audit unavailable/);
  assert.equal(journal.effect('dispatch'), null);
});

test('future schema is rejected before migrations or writes', t => {
  const { journal, db } = fixture(t).open();
  db.exec('UPDATE delivery_meta SET version=2');
  assert.throws(() => journal.initialize(), /Unsupported delivery schema/);
  assert.equal(db.prepare('SELECT version FROM delivery_meta').get().version, 2);
});

import { planAdmissions, validateDependencies, invalidatedDescendants, nextWindow, isolateBatch, integrationVerdict } from '../delivery/scheduler.mjs';
const item = (id, extra = {}) => ({ id, dependencies: [], slots: 1, state: 'eligible', priority: 0, enqueuedAt: 0, ...extra });

test('admission counts uncertain provider executions and blocks missing dependencies', () => {
  const plan = planAdmissions({ now: 100, capacity: 3, items: [item('a'), item('b', { dependencies: ['missing'] }), item('c')], attempts: [{ state: 'unknown', slots: 2, itemIds: ['other'] }] });
  assert.deepEqual(plan.admissions, [{ itemId: 'a', slots: 1 }]);
  assert.equal(plan.reasons.b, 'dependency'); assert.equal(plan.reasons.c, 'capacity');
});

test('aging prevents permanent priority starvation and leaves room for large jobs', () => {
  const items = [item('old', { slots: 2 }), item('new', { enqueuedAt: 999000, priority: 10 })];
  const plan = planAdmissions({ items, now: 1000000, agingMs: 1000, capacity: 2, attempts: [{ state: 'running', slots: 1, itemIds: [] }] });
  assert.deepEqual(plan.admissions, []);
  assert.equal(plan.reasons.old, 'capacity');
});

test('dependency cycles are refused; merge evidence unblocks dependents', () => {
  assert.throws(() => validateDependencies([item('a', { dependencies: ['b'] }), item('b', { dependencies: ['a'] })]), /cycle/);
  const plan = planAdmissions({ now: 10, capacity: 1, attempts: [], items: [item('a', { state: 'merged' }), item('b', { dependencies: ['a'] })] });
  assert.equal(plan.admissions[0].itemId, 'b');
});

test('speculative failure invalidates all descendants without unrelated attempts', () => {
  assert.deepEqual(invalidatedDescendants([{ id: 'c', predecessors: ['b'] }, { id: 'b', predecessors: ['a'] }, { id: 'd', predecessors: [] }], 'a'), ['b', 'c']);
  assert.equal(nextWindow({ current: 8, maximum: 10, outcome: 'integration-failure' }), 4);
  assert.equal(nextWindow({ current: 8, maximum: 10, outcome: 'infrastructure-failure' }), 8);
  assert.deepEqual(isolateBatch(['a', 'b', 'c']), [['a', 'b'], ['c']]);
});

test('integration checks reject stale base, forged app, skipped checks and newer failures', () => {
  const candidate = { head: 'a'.repeat(40), base: 'b'.repeat(40), sha: 'c'.repeat(40) };
  const check = { name: 'test', appId: 1, sha: 'c'.repeat(40), runId: 1, status: 'completed', conclusion: 'success' };
  const requiredChecks = [{ name: 'test', appId: 1 }];
  const verdict = (extra = {}, checks = [check]) => integrationVerdict({ candidate, requiredChecks, observation: { ...candidate, ...extra, checks } });
  assert.equal(verdict().ready, true);
  assert.equal(verdict({ base: 'changed' }).ready, false);
  assert.equal(verdict({}, [{ ...check, appId: 2 }]).ready, false);
  assert.equal(verdict({}, [{ ...check, conclusion: 'skipped' }]).ready, false);
  assert.equal(verdict({}, [check, { ...check, runId: 2, conclusion: 'failure' }]).ready, false);
});

import { DeliveryCapacity } from '../delivery/capacity.mjs';

test('state and outbox intents commit atomically', t => {
  const { journal } = fixture(t).open();
  const lease = journal.acquire('repo', 'worker', 100);
  journal.prepare(lease, 'same-id', { head: 'original' });
  assert.throws(() => journal.commit(lease, 'item', 0, { state: 'dispatch-pending' }, [
    { id: 'first-effect', intent: {} }, { id: 'same-id', intent: { head: 'different' } }
  ]), /identity conflict/);
  assert.equal(journal.read('item'), null);
  assert.equal(journal.effect('first-effect'), null);
  journal.commit(lease, 'item', 0, { state: 'dispatch-pending' }, [{ id: 'first-effect', intent: {} }]);
  assert.equal(journal.read('item').revision, 1);
  assert.equal(journal.effect('first-effect').state, 'pending');
});

test('account capacity persists across repositories and owner expiry', t => {
  const f = fixture(t), a = f.open().journal;
  const capacity = new DeliveryCapacity(a, 'account', { maximumSlots: 2 });
  const lease = a.acquire('account', 'worker', 100);
  assert.ok(capacity.reserve(lease, { id: 'a', repository: 'repo-a', slots: 2 }));
  assert.equal(capacity.reserve(lease, { id: 'b', repository: 'repo-b', slots: 1 }), null);
  f.advance(101);
  const b = f.open().journal, next = b.acquire('account', 'next', 100);
  const recovered = new DeliveryCapacity(b, 'account', { maximumSlots: 2 });
  assert.equal(recovered.reserve(next, { id: 'b', repository: 'repo-b', slots: 1 }), null);
  assert.throws(() => recovered.release(next, 'a', null), /evidence required/);
  recovered.release(next, 'a', { outcome: 'completed', receipt: 'run-123' });
  assert.ok(recovered.reserve(next, { id: 'b', repository: 'repo-b', slots: 1 }));
  assert.equal(recovered.reserve(next, { id: 'a', repository: 'repo-a', slots: 2 }).state, 'released');
});

test('journal paging never returns another repository data', t => {
  const journal = fixture(t).open().journal;
  const a = journal.acquire('a', 'worker', 100), b = journal.acquire('b', 'worker', 100);
  journal.write(a, 'a:1', 0, {}); journal.write(a, 'a:2', 0, {}); journal.write(b, 'b:1', 0, {});
  assert.deepEqual(journal.list('a', { limit: 1 }).map(row => row.id), ['a:1']);
  assert.deepEqual(journal.list('a', { after: 'a:1' }).map(row => row.id), ['a:2']);
});

import { executeEffect, reconcileEffect, GitHubDeliveryReader, ProviderFailure, retryDecision } from '../delivery/execution.mjs';

test('lost provider reply does not cause a second execution after restart', async t => {
  const f = fixture(t), a = f.open().journal;
  const lease = a.acquire('repo', 'worker', 100);
  a.prepare(lease, 'dispatch-1', { type: 'dispatch' });
  let sent = 0;
  const provider = {
    execute: async () => { sent += 1; throw new Error('Lost response after acceptance'); },
    reconcile: async () => ({ authoritative: true, receipt: { runId: 42 } })
  };
  assert.equal((await executeEffect({ journal: a, lease, effectId: 'dispatch-1', provider })).state, 'unknown');
  f.advance(101);
  const b = f.open().journal, next = b.acquire('repo', 'next', 100);
  await assert.rejects(executeEffect({ journal: b, lease: next, effectId: 'dispatch-1', provider }), /not dispatchable/);
  assert.equal((await reconcileEffect({ journal: b, lease: next, effectId: 'dispatch-1', provider })).receipt.runId, 42);
  assert.equal(sent, 1);
});

test('lease expiry during provider execution cannot publish a stale receipt', async t => {
  const f = fixture(t), a = f.open().journal, lease = a.acquire('repo', 'worker', 100);
  a.prepare(lease, 'dispatch', {});
  await assert.rejects(executeEffect({ journal: a, lease, effectId: 'dispatch', provider: { execute: async () => { f.advance(100); return { accepted: true }; } } }), /Stale/);
  assert.equal(a.effect('dispatch').state, 'unknown');
});

test('retry policy respects server delays and never retries auth/test failures', () => {
  assert.deepEqual(retryDecision(new ProviderFailure('rate-limit', '', { retryAfterMs: 90000 }), { attempt: 1, now: 100 }), { retry: true, at: 90100 });
  assert.equal(retryDecision(new ProviderFailure('authorization', ''), { attempt: 1, now: 100 }).retry, false);
  assert.equal(retryDecision(new ProviderFailure('infrastructure', ''), { attempt: 4, now: 100 }).retry, false);
});

test('GitHub check reader paginates all runs and rejects partial results', async () => {
  let count = 0;
  const reader = new GitHubDeliveryReader({ repository: 'owner/repo', request: async () => ({ status: 200, body: { check_runs: ++count === 1 ? Array.from({ length: 100 }, (_, id) => ({ id, name: 'test', app: { id: 1 } })) : [] } }) });
  assert.equal((await reader.checks('a'.repeat(40))).length, 100);
  assert.equal(count, 2);
  const bounded = new GitHubDeliveryReader({ repository: 'owner/repo', maximumPages: 1, request: async () => ({ status: 200, body: Array(100).fill({}) }) });
  await assert.rejects(bounded.pages('/example'), error => error.kind === 'incomplete');
});

import { shadowReconcile } from '../scripts/delivery-coordinator.mjs';

test('operational shadow command persists observations without executing provider writes', async t => {
  const { journal } = fixture(t).open();
  const paths = [];
  const reader = new GitHubDeliveryReader({ repository: 'owner/repo', request: async ({ method, path }) => {
    assert.equal(method, 'GET'); paths.push(path);
    return { status: 200, body: [{ number: 1, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) },
      draft: false, labels: [{ name: 'ready-to-land' }], created_at: '2026-01-01T00:00:00Z' }] };
  } });
  const result = await shadowReconcile({ journal, reader, installation: '123', ref: 'main', capacity: 2, now: 1800000000000 });
  assert.equal(result.mode, 'shadow'); assert.equal(paths.length, 1);
  assert.equal(result.plan.admissions[0].itemId, 'pr:1');
  assert.equal(result.assumptions.existingGitHubRunsNotCounted, true);
  const resource = repositoryResource({ installation: '123', repository: 'owner/repo', ref: 'main' });
  assert.equal(journal.list(resource)[0].value.data.itemCount, 1);
  assert.equal(journal.list(resource)[1].value.data.head, 'a'.repeat(40));
  assert.ok(journal.acquire(resource, 'next', 100));
});

test('malformed candidate identities never qualify for integration', () => {
  assert.equal(integrationVerdict({ candidate: {}, observation: { checks: [] }, requiredChecks: [] }).ready, false);
});

import { reconcilePulls, workflowVerdict } from '../delivery/reconcile.mjs';
const workflow = (extra = {}) => ({ id: 1, path: '.github/workflows/test.yml', event: 'pull_request', head_sha: 'a'.repeat(40), run_number: 1, run_attempt: 1, status: 'queued', conclusion: null, ...extra });

test('a waiting PR is rechecked after restart without being reselected', async t => {
  const f = fixture(t), journal = f.open().journal;
  const pull = { state: 'open', head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'owner/repo' } } };
  let completed = false, reads = 0;
  const reader = { repository: 'owner/repo', pull: async () => { reads += 1; return pull; }, runs: async () => [workflow(completed ? { status: 'completed', conclusion: 'success' } : {})] };
  const options = { reader, installation: '123', ref: 'main', requiredWorkflows: ['.github/workflows/test.yml'] };
  assert.equal((await reconcilePulls({ ...options, journal, numbers: [1] })).observations[0].state, 'waiting-checks');
  assert.equal((await reconcilePulls({ ...options, journal })).observations.length, 0);
  assert.equal(reads, 2);
  f.advance(240000); completed = true;
  const result = await reconcilePulls({ ...options, journal: f.open().journal });
  assert.equal(result.observations[0].state, 'checks-passed');
  assert.equal(result.observations[0].mergeAuthorized, false);
  assert.equal(result.observations[0].changed, true);
});

test('latest workflow attempt supersedes cancelled runs; other events and heads cannot qualify', () => {
  const policy = ['.github/workflows/test.yml'];
  const runs = [workflow({ status: 'completed', conclusion: 'cancelled' }), workflow({ id: 2, run_number: 2 })];
  assert.equal(workflowVerdict(runs, 'a'.repeat(40), policy).state, 'waiting-checks');
  assert.equal(workflowVerdict([workflow({ event: 'workflow_dispatch', status: 'completed', conclusion: 'success' })], 'a'.repeat(40), policy).state, 'missing-checks');
  assert.equal(workflowVerdict([workflow()], 'c'.repeat(40), policy).state, 'missing-checks');
});

test('head movement during observation invalidates green evidence', async t => {
  const journal = fixture(t).open().journal;
  let reads = 0;
  const reader = { repository: 'owner/repo', pull: async () => ({ state: 'open', head: { sha: (++reads === 1 ? 'a' : 'c').repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'owner/repo' } } }), runs: async () => [workflow({ status: 'completed', conclusion: 'success' })] };
  const result = await reconcilePulls({ journal, reader, installation: '123', ref: 'main', numbers: [1], requiredWorkflows: ['.github/workflows/test.yml'] });
  assert.equal(result.observations[0].state, 'changed-during-read');
  assert.deepEqual(result.observations[0].evidence, []);
});

test('provider failures remain scheduled and closed PRs stop polling', async t => {
  const f = fixture(t), journal = f.open().journal;
  let fail = true;
  const reader = { repository: 'owner/repo', pull: async () => { if (fail) throw new ProviderFailure('rate-limit', 'limited'); return { state: 'closed', merged: true, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'owner/repo' } } }; } };
  const options = { journal, reader, installation: '123', ref: 'main' };
  const result = await reconcilePulls({ ...options, numbers: [1] });
  assert.equal(result.observations[0].state, 'observation-error');
  f.advance(240000); fail = false;
  assert.equal((await reconcilePulls(options)).observations[0].state, 'merged');
  f.advance(240000);
  assert.equal((await reconcilePulls(options)).observations.length, 0);
});
