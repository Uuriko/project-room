import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { event } from '../src/events.js';
import { normalizeClaimRepository } from '../server/work-claims.mjs';

async function fixture(t) {
  let now = Date.now();
  const store = new RoomStore(':memory:', { now: () => now, workItemBoardBackfill: 'manual' });
  store.initialize(initialRoom('commons'));
  const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'add-worker', type: 'member.added', data: {
    memberId: 'worker', displayName: 'Worker', kind: 'human', permissions: ['accept_work', 'complete_work', 'write_external'] } });
  const worker = store.issueAccessKey('commons', 'worker');
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${worker}`, 'Content-Type': 'application/json' };
  let requestId = 0;
  const item = id => store.room('commons').state.workItems[id];
  const propose = id => {
    store.command(owner, 'commons', { id: `propose-${id}`, type: 'work.proposed', data: {
      workItemId: id, title: id, definitionOfDone: 'Done', accountableMemberId: 'worker', mode: 'write' } });
    store.command(worker, 'commons', { id: `accept-${id}`, type: 'work.accepted', data: { workItemId: id, expectedRevision: item(id).revision } });
  };
  const acquire = (id, repository, extra = {}) => fetch(origin + '/api/rooms/commons/commands', {
    method: 'POST', headers, body: JSON.stringify({ id: `acquire-${++requestId}`, type: 'claim.acquired', data: {
      workItemId: id, expectedRevision: item(id).revision, repository, ref: 'main', paths: ['server/**'],
      expiresAt: new Date(now + 60000).toISOString(), ...extra } }) });
  return { store, item, propose, acquire, advance: ms => { now += ms; },
    list: () => fetch(origin + '/api/rooms/commons/work-claims', { headers }) };
}

test('canonical GitHub URL stays in journal/replay while mirror and expiry use a valid repository', async t => {
  const f = await fixture(t); f.propose('url-task');
  const repository = 'https://github.com/Uuriko/project-room.git/';
  const response = await f.acquire('url-task', repository); assert.equal(response.status, 201, await response.clone().text());
  const receipt = await response.json(); assert.equal(receipt.event.data.repository, repository);
  assert.equal(f.item('url-task').claim.repository, repository);
  assert.equal(f.store.rebuildProjection('commons').state.workItems['url-task'].claim.repository, repository);
  assert.equal(f.store.workClaims.get('commons', 'url-task').repo, 'Uuriko/project-room');
  const report = f.store.backfillRoomWorkItemClaims('commons'); assert.deepEqual(report.errors, []);
  f.advance(61000);
  const listed = await f.list(); assert.equal(listed.status, 200);
  assert.equal(f.store.workClaims.get('commons', 'url-task').state, 'unclaimed');
});

test('GitHub URL and owner/name spellings cannot evade canonical same-ref conflicts', async t => {
  const f = await fixture(t); f.propose('first'); f.propose('second');
  assert.equal((await f.acquire('first', 'https://github.com/Uuriko/project-room.git')).status, 201);
  const sequence = f.store.room('commons').sequence, revision = f.item('second').revision;
  const refused = await f.acquire('second', 'uuriko/project-room');
  assert.equal(refused.status, 409); assert.equal((await refused.json()).error.code, 'claim_conflict');
  assert.equal(f.store.room('commons').sequence, sequence); assert.equal(f.item('second').revision, revision);
  f.advance(61000);
  assert.equal((await f.acquire('second', 'uuriko/project-room')).status, 201);
});

test('unrepresentable repository values fail before event or Board writes', async t => {
  const f = await fixture(t); f.propose('invalid');
  for (const repository of ['https://github.com/owner/repo?token=private', 'https://user:pass@github.com/owner/repo',
    'https://github.com:443/owner/repo', 'https://github.com/owner/repo#ref', 'https://example.org/owner/repo',
    'git@github.com:owner/repo', 'owner/repo with space', 'a'.repeat(201)]) {
    const before = f.store.room('commons').sequence, row = f.store.workClaims.get('commons', 'invalid');
    const response = await f.acquire('invalid', repository);
    assert.equal(response.status, 422, repository); assert.equal((await response.json()).error.code, 'invalid_claim_scope');
    assert.equal(f.store.room('commons').sequence, before); assert.deepEqual(f.store.workClaims.get('commons', 'invalid'), row);
  }
});

test('repository conversion is narrow and does not reinterpret unsupported historical strings', () => {
  for (const value of ['git@github.com:owner/repo', 'https://elsewhere.test/owner/repo', 'repo', null, 42]) {
    assert.equal(normalizeClaimRepository(value), value);
  }
  assert.equal(normalizeClaimRepository('https://github.com/owner/repo'), 'owner/repo');
});


test('previously accepted unsupported repository strings still initialize and replay unchanged', async t => {
  const f = await fixture(t), roomId = 'legacy';
  const events = initialRoom(roomId);
  for (const [id, repository] of [['url', 'https://github.com/owner/repo'], ['ssh', 'git@github.com:owner/repo']]) {
    const add = (type, data) => events.push(event({ type, roomId, actorId: 'owner', data }));
    add('work.proposed', { workItemId: id, title: id, definitionOfDone: 'Historical', accountableMemberId: 'owner', mode: 'write' });
    add('work.accepted', { workItemId: id, expectedRevision: 0 });
    add('claim.acquired', { workItemId: id, expectedRevision: 1, repository, ref: 'legacy:ref', paths: ['src/**'], expiresAt: '2099-01-01T00:00:00Z' });
  }
  f.store.initialize(events);
  const original = f.store.room(roomId).state;
  assert.equal(original.workItems.ssh.claim.repository, 'git@github.com:owner/repo');
  assert.equal(original.workItems.ssh.claim.ref, 'legacy:ref');
  assert.equal(original.workItems.url.claim.repository, 'https://github.com/owner/repo');
  assert.deepEqual(f.store.rebuildProjection(roomId).state, original);
});


test('arbitrary repository names retain their existing case-sensitive identity', async t => {
  const f = await fixture(t); f.propose('upper'); f.propose('lower');
  assert.equal((await f.acquire('upper', 'LocalWorkspace')).status, 201);
  assert.equal((await f.acquire('lower', 'localworkspace')).status, 201);
});


test('unsupported refs cannot poison the Board or append a canonical event', async t => {
  const f = await fixture(t); f.propose('invalid-ref');
  for (const ref of ['branch:part', 'branch with space', 'a'.repeat(201)]) {
    const before = f.store.room('commons').sequence, row = f.store.workClaims.get('commons', 'invalid-ref');
    const response = await f.acquire('invalid-ref', 'owner/repo', { ref });
    assert.equal(response.status, 422); assert.equal((await response.json()).error.code, 'invalid_claim_scope');
    assert.equal(f.store.room('commons').sequence, before); assert.deepEqual(f.store.workClaims.get('commons', 'invalid-ref'), row);
  }
  assert.equal((await f.acquire('invalid-ref', 'owner/repo', { ref: 'codex/valid-branch_1.0' })).status, 201);
  assert.equal(f.store.workClaims.get('commons', 'invalid-ref').branch, 'codex/valid-branch_1.0');
});
