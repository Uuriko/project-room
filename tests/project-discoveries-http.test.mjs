import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createOperatorPurge } from '../server/operator-purge.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

const origin = 'https://room.example.org';
const path = id => '/api/project-offers/' + id + '/discoveries';
const review = id => '/api/rooms/commons/project-offers/' + id + '/discoveries';
const input = { requestId: 'first-check', expectedTermsVersion: 1, expectedRevision: 2,
  sourceUrl: 'https://github.com/example/project/blob/main/README.md#install',
  criterion: 'Check the install instructions', observation: 'The example references a missing file.',
  nextAction: 'Correct the filename in the example.' };

async function fixture(t, normalized = true) {
  const dir = mkdtempSync(join(tmpdir(), 'room-discoveries-'));
  const dbPath = join(dir, 'room.sqlite');
  const store = new RoomStore(dbPath);
  store.initialize(initialRoom(), normalized ? { representation: 'normalized-current-v1' } : {});
  const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'add-reader', type: 'member.added',
    data: { memberId: 'reader', displayName: 'Reader', kind: 'human', permissions: [] } });
  const reader = store.issueAccessKey('commons', 'reader');
  store.command(owner, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: ['decide'] } });
  const reviewer = store.issueAccessKey('commons', 'reviewer');
  const outside = store.identities.create('External contributor');
  const second = store.identities.create('Second external contributor');
  if (normalized) store.room = () => { throw new Error('Unexpected full room read'); };
  const publish = (id, overrides = {}, published = true, reviewerMemberIds = ['owner'], roomId = 'commons') => {
    store.projectOffers.create(roomId, 'owner', { requestId: 'create-' + id, offerId: id, reviewerMemberIds,
      terms: { title: id, kind: 'project', acceptanceCriteria: [input.criterion], summary: 'Review public documentation',
        repositoryUrl: 'https://github.com/example/project', submissionUrl: origin + path(id),
        reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' }, ...overrides } });
    if (published) store.projectOffers.transition(roomId, 'owner', id, 'publish', { requestId: 'publish-' + id, expectedRevision: 1 });
  };
  const server = createRoomServer({ store, origin });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  // Exercise HTTPS canonical origin checks over an isolated loopback transport.
  const call = (route, key, data) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: data ? 'POST' : 'GET',
      headers: { Host: new URL(origin).host, Origin: origin, ...(key && { Authorization: 'Bearer ' + key }),
        ...(data && { 'Content-Type': 'application/json' }) } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
  return { store, dbPath, call, publish, owner, reader, reviewer, outside, second };
}

for (const normalized of [true, false]) test('scope and replay of discovery filings, normalized=' + normalized, async t => {
  const { store, dbPath, call, publish, owner, reader, reviewer, outside, second } = await fixture(t, normalized);
  publish('project-a', {}, true, ['owner', 'reviewer']); publish('project-b');
  const send = (body, token = outside.secret) => call(path('project-a'), token, body);
  const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
  assert.equal((await send(input, null)).status, 401);
  assert.equal((await send(input, owner)).status, 401);
  const [filed, replay] = await Promise.all([send(input), send(input)]);
  assert.equal(filed.status, 200, JSON.stringify(filed.json)); assert.deepEqual(replay, filed);
  assert.equal(filed.json.finding.observation, input.observation); assert.match(filed.json.receiptId, /^finding-[0-9a-f]{64}$/);
  assert.equal((await send({ ...input, observation: 'Another observation' })).status, 409);
  assert.equal((await send({ ...input, expectedRevision: 1 })).status, 409);
  assert.equal((await send({ ...input, expectedTermsVersion: 2 })).status, 409);
  assert.equal((await send({ ...input, criterion: 'Unpublished criterion' })).status, 422);
  assert.equal((await send({ ...input, sourceUrl: 'https://127.0.0.1/private' })).status, 422);
  assert.equal((await send({ ...input, observation: 'Bearer pri_syntheticOnlyForTest' })).status, 422);
  assert.equal((await call(review('project-a'), reader)).status, 403);
  assert.equal((await call(review('project-a'), outside.secret)).status, 403);
  assert.equal((await call(review('project-a'), null)).status, 401);
  assert.deepEqual((await call(review('project-a'), owner)).json.findings, [filed.json]);
  assert.deepEqual((await call(review('project-a'), reviewer)).json.findings, [filed.json]);
  assert.equal((await call(review('project-b'), reviewer)).status, 403);
  assert.deepEqual((await call(review('project-b'), owner)).json.findings, []);
  assert.ok(!JSON.stringify((await call('/api/project-offers/project-a', null)).json).includes(input.observation));
  const secondReceipt = await send({ ...input, observation: 'A separate finding' }, second.secret);
  assert.equal(secondReceipt.status, 200); assert.notEqual(secondReceipt.json.receiptId, filed.json.receiptId);
  const differentOffer = await call(path('project-b'), outside.secret, input);
  assert.equal(differentOffer.status, 200); assert.notEqual(differentOffer.json.receiptId, filed.json.receiptId);
  assert.deepEqual((await call(review('project-b'), owner)).json.findings, [differentOffer.json]);
  assert.equal((await call(path('project-a'), outside.secret)).status, 405);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM public_work_tasks').get().n, 0);
  assert.equal(store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence, sequence);
  const reopened = new RoomStore(dbPath, { readOnly: true });
  try {
    const row = reopened.db.prepare('SELECT outcome_json FROM public_work_requests WHERE offer_id=? AND actor_id=? AND request_id=?')
      .get('project-discovery/commons/project-a', outside.identityId, input.requestId);
    assert.deepEqual(JSON.parse(row.outcome_json), filed.json);
  } finally { reopened.close(); }
});

test('filing requires published project consent on this exact origin and path, including on replay', async t => {
  const { store, call, publish, owner, outside } = await fixture(t);
  for (const [id, overrides] of [
    ['other-origin', { submissionUrl: 'https://other.example.org' + path('other-origin') }],
    ['wrong-path', { submissionUrl: origin + path('different') }],
    ['external', { submissionUrl: 'https://example.org/form' }],
    ['paid', { reward: { kind: 'cash', unit: 'USD', amountMinor: '100' } }],
    ['task', { kind: 'task' }],
  ]) {
    publish(id, overrides);
    assert.equal((await call(path(id), outside.secret, input)).status, 404, id);
  }
  publish('default', { submissionUrl: null });
  assert.equal((await call(path('default'), outside.secret, input)).status, 200);
  assert.equal((await call(review('default'), owner)).json.findings[0].finding.observation, input.observation);
  publish('draft', {}, false);
  assert.equal((await call(path('draft'), outside.secret, input)).status, 404);
  publish('guard');
  assert.equal((await call(path('guard'), outside.secret, input)).status, 200);
  store.db.prepare('INSERT INTO public_unpublish (kind,target,at,by_account) VALUES (?,?,?,?)').run('room','commons',store.now(),'operator');
  assert.equal((await call(path('guard'), outside.secret, input)).status, 404);
  assert.equal((await call(review('guard'), owner)).status, 404);
  store.db.prepare('DELETE FROM public_unpublish WHERE kind=? AND target=?').run('room','commons');
  store.projectOffers.transition('commons', 'owner', 'guard', 'withdraw', { requestId: 'withdraw', expectedRevision: 2 });
  assert.equal((await call(path('guard'), outside.secret, input)).status, 404);
  store.command(owner, 'commons', { id: 'archive', type: 'room.archived', data: {} });
  assert.equal((await call(path('default'), outside.secret, input)).status, 404);
});

test('filing capacity is scoped to each contributor and project, exact retries survive a full journal', async t => {
  const { store, call, publish, outside, second } = await fixture(t);
  let now = store.now();
  store.now = () => now;
  publish('caps'); publish('elsewhere');
  for (let n = 0; n < 5; n++) assert.equal((await call(path('caps'), outside.secret, { ...input, requestId: 'check-' + n })).status, 200);
  assert.equal((await call(path('caps'), outside.secret, input)).status, 429);
  assert.equal((await call(path('caps'), second.secret, input)).status, 200);
  assert.equal((await call(path('elsewhere'), outside.secret, input)).status, 200);
  // Fill the remaining slots without sending enough HTTP calls to trip the distinct IP ceiling.
  const insert = store.db.prepare('INSERT INTO public_work_requests VALUES (?,?,?,?,?)');
  const synthetic = JSON.stringify({ recordedAt: new Date(now).toISOString(), receiptId: 'synthetic' });
  for (let n = 0; n < 94; n++) insert.run('project-discovery/commons/caps', 'fixture-' + n, 'fixture', '{}', synthetic);
  assert.equal((await call(path('caps'), second.secret, { ...input, requestId: 'next' })).status, 429);
  assert.equal((await call(path('caps'), second.secret, input)).status, 200);
  now += 24 * 60 * 60 * 1000 - 1;
  assert.equal((await call(path('caps'), outside.secret, input)).status, 429);
  now++;
  assert.equal((await call(path('caps'), outside.secret, input)).status, 200);
  assert.equal((await call(path('caps'), second.secret, { ...input, requestId: 'next' })).status, 200);
  assert.equal((await call(path('caps'), outside.secret, { ...input, requestId: 'check-0' })).status, 200);
});

test('review continuation preserves older findings across concurrent newer filings and tied times', async t => {
  const { store, call, publish, owner, outside } = await fixture(t);
  let now = store.now();
  store.now = () => now;
  publish('pages'); publish('other');
  const receipts = [];
  for (const id of ['oldest', 'middle-a', 'middle-b', 'newest']) {
    if (!id.startsWith('middle-b')) now++;
    const result = await call(path('pages'), outside.secret, { ...input, requestId: id });
    assert.equal(result.status, 200); receipts.push(result.json);
  }
  const expected = [...receipts].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.receiptId.localeCompare(a.receiptId));
  const first = (await call(review('pages') + '?limit=2', owner)).json;
  assert.deepEqual(first.findings, expected.slice(0, 2)); assert.ok(first.nextCursor);
  now++;
  assert.equal((await call(path('pages'), outside.secret, { ...input, requestId: 'later' })).status, 200);
  const second = (await call(review('pages') + '?limit=2&after=' + first.nextCursor, owner)).json;
  assert.deepEqual(second.findings, expected.slice(2)); assert.equal(second.nextCursor, null);
  assert.equal((await call(review('other') + '?after=' + first.nextCursor, owner)).status, 422);
  for (const query of ['?after=malformed', '?after=', '?limit=51', '?limit=0', '?limit=1&limit=2']) {
    assert.equal((await call(review('pages') + query, owner)).status, 422);
  }
});

test('operator room purge erases only scoped discoveries before an offer ID is reused', async t => {
  const { store, call, publish, outside, owner } = await fixture(t);
  const oldRoom = 'discovery-room';
  store.initialize(initialRoom(oldRoom), { representation: 'normalized-current-v1' });
  publish('reused', {}, true, ['owner'], oldRoom);
  publish('kept');
  const removed = await call(path('reused'), outside.secret, input);
  const kept = await call(path('kept'), outside.secret, input);
  assert.equal(removed.status, 200); assert.equal(kept.status, 200);
  const insert = store.db.prepare('INSERT INTO public_work_requests VALUES (?,?,?,?,?)');
  insert.run('project-discovery/reused', outside.identityId, 'older-format', '{}', JSON.stringify(removed.json));
  // This ordinary task operation shares the deleted project's offer ID and contributor.
  insert.run('reused', outside.identityId, 'old-lease', '{"action":"claim"}', '{"generation":1}');
  const purge = createOperatorPurge(store);
  const plan = purge.plan({ targets: [{ kind: 'room', id: oldRoom }], reason: 'Clean up synthetic room' }, crypto.randomUUID());
  assert.equal(plan.counts.find(entry => entry.table === 'public_work_requests').rows, 2);
  assert.equal(purge.execute({ planId: plan.planId, confirmToken: plan.confirmToken }, crypto.randomUUID()).result, 'executed');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM public_work_requests').get().n, 2);
  assert.equal(store.db.prepare('SELECT outcome_json FROM public_work_requests WHERE offer_id=? AND actor_id=? AND request_id=?')
    .get('reused', outside.identityId, 'old-lease').outcome_json, '{"generation":1}');
  assert.deepEqual((await call(review('kept'), owner)).json.findings, [kept.json]);
  publish('reused');
  assert.deepEqual((await call(review('reused'), owner)).json.findings, []);
  const fresh = await call(path('reused'), outside.secret, input);
  assert.equal(fresh.status, 200); assert.notEqual(fresh.json.receiptId, removed.json.receiptId);
});
