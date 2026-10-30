import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { availableBoardRows } from '../server/available-work.mjs';
import { replay } from '../src/events.js';
import { assertDependsOnKnown } from '../server/work-claim-integrity.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'room-dependencies-'));
  const store = new RoomStore(join(dir, 'room.sqlite'));
  const identity = store.identities.create('Owen');
  new AgentRooms(store).create(identity.secret, { roomId: 'test-room', title: 'Dependencies', purpose: 'Test', kind: 'personal', displayName: 'Owen' });
  const server = createRoomServer({ store }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new RoomAgentClient({ origin, roomId: 'test-room', token: identity.secret });
  const command = (type, data) => client.command({ id: crypto.randomUUID(), type, data });
  const proposal = (id, dependsOn) => ({ workItemId: id, title: id, definitionOfDone: 'Verified result', accountableMemberId: identity.identityId,
    mode: 'write', independentVerificationRequired: false, ownerDecisionRequired: false, ...(dependsOn === undefined ? {} : { dependsOn }) });
  const call = async (name, args) => {
    const res = await fetch(`${origin}/room/mcp?profile=full`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'tools/call', params: { name, arguments: { roomId: 'test-room', ...args } } }) });
    return (await res.json()).result;
  };
  const state = () => store.room('test-room');
  const acquire = id => command('claim.acquired', { workItemId: id, expectedRevision: state().state.workItems[id].revision,
    repository: 'acme/test', ref: 'main', paths: [id+'.js'], expiresAt: new Date(Date.now()+3600000).toISOString() });
  const ready = async () => (await (await fetch(`${origin}/api/rooms/test-room/work-claims?queue=ready`, { headers: { Authorization: `Bearer ${identity.secret}` } })).json()).claims;
  return { store, client, command, proposal, call, state, acquire, ready };
}

test('canonical MCP proposal dependency excludes available work and atomically refuses acquire until Board completion', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'base', reviewPolicy: 'self_attested' });
  const proposed = await f.call('room_propose_work', { ...f.proposal('child', ['base']), requestId: 'propose-child' });
  assert.equal(proposed.isError, undefined, JSON.stringify(proposed));
  assert.equal(proposed.structuredContent.status, 'recorded');
  await f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 });
  assert.deepEqual(f.store.workClaims.get('test-room', 'child').dependsOn, ['base']);
  assert.equal(availableBoardRows(f.store.workClaims.list('test-room')).some(x => x.id === 'child'), false);
  assert.equal((await f.ready()).some(x => x.id === 'child'), false);
  const before = f.state().sequence;
  await assert.rejects(f.acquire('child'), e => e.status === 409 && e.code === 'work_claim_dependencies_unmet');
  assert.equal(f.state().sequence, before);
  assert.equal(f.state().state.workItems.child.claim, null);
  const read = (await f.call('room_read_work', { workItemId: 'child' })).structuredContent;
  assert.deepEqual(read.dependencies, [{ id: 'base', state: 'unclaimed', satisfied: false }]);
  const brief = (await f.call('room_read_work', { workItemId: 'child', brief: true })).structuredContent.brief;
  assert.match(brief, /base: unclaimed \(not satisfied\)/);
  assert.match(brief, /Do not claim or start/);
  await f.client.claimWorkItem('base');
  await f.client.updateWorkItem('base', { state: 'in_progress' });
  await f.client.updateWorkItem('base', { state: 'done' });
  assert.equal(availableBoardRows(f.store.workClaims.list('test-room')).some(x => x.id === 'child'), true);
  assert.equal((await f.ready()).some(x => x.id === 'child'), true);
  assert.equal((await f.client.workContext('child')).dependencies[0].satisfied, true);
  await f.acquire('child');
  assert.equal(f.state().state.workItems.child.claim.status, 'active');
});

test('proposal validates self, missing and bounds without saving, and acceptance rechecks deletion', async t => {
  const f = await fixture(t);
  for (const deps of [['child'], ['missing'], Array.from({ length: 17 }, (_, i) => 'x'+i), [123]]) {
    const before = f.state().sequence;
    await assert.rejects(f.command('work.proposed', f.proposal('child', deps)), e => e.status === 422);
    assert.equal(f.state().sequence, before);
    assert.equal(f.state().state.workItems.child, undefined);
    assert.equal(f.store.workClaims.get('test-room', 'child'), null);
  }
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', f.proposal('child', ['base']));
  f.store.workClaims.delete('test-room', 'base');
  const before = f.state().sequence;
  await assert.rejects(f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 }), e => e.code === 'invalid_claim_input');
  assert.equal(f.state().sequence, before);
  assert.equal(f.state().state.workItems.child.state, 'proposed');
});

test('existing Board deletion waiver stays authoritative on canonical read and acquisition', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', f.proposal('child', ['base']));
  await f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 });
  f.store.workClaims.delete('test-room', 'base');
  assert.deepEqual((await f.client.workContext('child')).dependencies, []);
  await f.acquire('child');
  assert.deepEqual(f.store.workClaims.get('test-room', 'child').dependsOn, []);
  const events = f.store.db.prepare('SELECT body FROM events WHERE room_id=? ORDER BY sequence').all('test-room').map(row => JSON.parse(row.body));
  assert.deepEqual(replay(events).workItems.child.dependsOn, ['base'], 'replay preserves the declaration without consulting mutable Board/deleted targets');
});

test('shared Board admission rejects an indirect cycle and bounds graph traversal', () => {
  const reject = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
  const graph = new Map([['a', { dependsOn: ['b'] }], ['b', { dependsOn: ['self'] }]]);
  assert.throws(() => assertDependsOnKnown(reject, { dependsOn: ['a'] }, { selfId: 'self', has: id => graph.has(id), get: id => graph.get(id) }), /cycle/);
  assert.throws(() => assertDependsOnKnown(reject, { dependsOn: ['0'] }, { selfId: 'self', has: () => true,
    get: id => ({ dependsOn: [String(Number(id)+1)] }) }), /validation bound/);
});

test('read-mode start obeys dependencies and permission refusal writes nothing', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', { ...f.proposal('reader', ['base']), mode: 'read' });
  await f.command('work.accepted', { workItemId: 'reader', expectedRevision: 0 });
  const before = f.state().sequence;
  await assert.rejects(f.command('work.started', { workItemId: 'reader', expectedRevision: 1 }), e => e.code === 'work_claim_dependencies_unmet');
  assert.equal(f.state().sequence, before);
  assert.equal(f.state().state.workItems.reader.state, 'accepted');
  await f.command('member.added', { memberId: 'outsider', displayName: 'Alex', kind: 'agent', permissions: [] });
  const key = f.store.mintAccessKey('test-room', 'outsider');
  const seq = f.state().sequence;
  assert.throws(() => f.store.command(key, 'test-room', { id: crypto.randomUUID(), type: 'work.proposed', data: f.proposal('forbidden', ['base']) }), /lacks steer/);
  assert.equal(f.state().sequence, seq);
});

test('Board cycle hardening refuses a newly closed indirect cycle through its real HTTP endpoint', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'a' });
  await f.client.workClaimCreate({ id: 'b', dependsOn: ['a'] });
  const before = f.state().sequence;
  await assert.rejects(f.client.claimWorkItem('a', { dependsOn: ['b'] }), e => e.code === 'invalid_claim_input' && /cycle/.test(e.message));
  assert.equal(f.state().sequence, before);
  assert.deepEqual(f.store.workClaims.get('test-room', 'a').dependsOn, []);
});

test('encoded self ID is refused and mirror storage failure rolls acceptance back atomically', async t => {
  const f = await fixture(t);
  const { boardClaimId } = await import('../server/work-item-board.mjs');
  const before = f.state().sequence;
  await assert.rejects(f.command('work.proposed', f.proposal('child.with-dot', [boardClaimId('child.with-dot')])), e => e.code === 'invalid_claim_input');
  assert.equal(f.state().sequence, before);
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', f.proposal('child', ['base']));
  const seq = f.state().sequence;
  const set = f.store.workClaims.set.bind(f.store.workClaims);
  f.store.workClaims.set = () => { throw new Error('injected Board storage failure'); };
  await assert.rejects(f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 }));
  f.store.workClaims.set = set;
  assert.equal(f.state().sequence, seq);
  assert.equal(f.state().state.workItems.child.state, 'proposed');
  assert.equal(f.store.workClaims.get('test-room', 'child'), null);
  await f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 });
  assert.deepEqual(f.store.workClaims.get('test-room', 'child').dependsOn, ['base']);
  const snapshot = f.store.snapshot(f.store.mintAccessKey('test-room', f.state().state.room.ownerId), 'test-room');
  assert.deepEqual(snapshot.state.workItems.child.dependsOn, ['base']);
});
