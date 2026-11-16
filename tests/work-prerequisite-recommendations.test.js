import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { readWorkItem } from '../server/work-repository.mjs';
import { textVersion } from '../server/text-results.mjs';
import { buildProjectState } from '../server/project-state.mjs';
import { workContinuation } from '../client/work-preparation.mjs';
import { beginSelectedWork, prerequisiteHold } from '../client/begin-work.mjs';
import { event, PERMISSIONS } from '../src/events.js';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

// Recommendations must agree with claim/start admission for prerequisites.
// Reads stay advisory: every case that says "start" is also tried against the gate.
async function nativeFixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom(), { representation: 'normalized-current-v1' });
  const owner = store.issueAccessKey('commons', 'owner');
  const producer = store.identities.create('Producer');
  linkWithProof(store, owner, 'commons', producer, { displayName: 'Producer', permissions: ['accept_work', 'complete_work'] });
  setTier(store.db, 'commons', producer.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const send = (key, type, data, id = crypto.randomUUID()) => store.command(key, 'commons', { id, type, data });
  send(owner, 'member.added', { memberId: 'verifier', displayName: 'Verifier', kind: 'agent', permissions: ['verify'] });
  const verifier = store.issueAccessKey('commons', 'verifier');
  const producerKey = store.issueAccessKey('commons', producer.identityId);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (name, args = {}) => {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + producer.secret },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { roomId: 'commons', ...args } } }) });
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body));
    return body.result.structuredContent;
  };
  const item = id => readWorkItem(store.db, 'commons', id);
  const propose = (id, extra = {}) => send(owner, 'work.proposed', { workItemId: id, title: id, definitionOfDone: 'Saved result',
    accountableMemberId: producer.identityId, mode: 'read', ...extra });
  const submit = id => {
    const body = 'Exact saved result ' + id;
    const post = send(producerKey, 'message.posted', { messageId: 'result-' + id, workItemId: id, body });
    return send(producerKey, 'work.completed', { workItemId: id, expectedRevision: item(id).revision, evidenceKind: 'room_text',
      evidenceMessageId: 'result-' + id, evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body),
      previousCompletionEventId: null, producerId: producer.identityId, summary: 'Saved', nextAction: 'Review' });
  };
  const pass = (id, completion) => send(verifier, 'verification.recorded', { workItemId: id, expectedRevision: item(id).revision, result: 'pass',
    completionEventId: completion.event.id, evidenceVersion: item(id).receipt.evidenceVersion, summary: 'Checked exact result' });
  const start = id => send(producerKey, 'work.started', { workItemId: id, expectedRevision: item(id).revision });
  const row = (state, id) => [...state.needsYou, ...state.inProgress].find(entry => entry.id === id);
  return { store, owner, producer, producerKey, send, call, item, propose, submit, pass, start, row };
}

test('native: brief, continuation, begin and project state wait for an unfinished prerequisite and release on the exact gate', async t => {
  const f = await nativeFixture(t);
  f.propose('base', { independentVerificationRequired: true, verifierMemberId: 'verifier' });
  f.propose('child', { dependsOn: ['base'] });
  f.propose('plain');

  // Accepting is still offered; it carries what the later start waits on.
  const proposed = await f.call('room_read_work', { workItemId: 'child', brief: true });
  assert.match(proposed.brief, /Do not claim or start/);
  assert.equal(proposed.continuation.action, 'accept');
  assert.equal(proposed.continuation.tool, 'room_begin_work');
  assert.deepEqual(proposed.continuation.waitingOn, [{ id: 'base', state: 'unclaimed' }]);
  const accepted = await f.call('room_begin_work', { workItemId: 'child' });
  assert.deepEqual(accepted.confirmed.map(stage => stage.action), ['room_accept_work']);
  assert.equal(accepted.stopped, 'waiting_on_prerequisites', 'begin must not attempt a start admission already rules out');
  assert.equal(accepted.refusal, undefined);
  assert.deepEqual(accepted.waitingOn, [{ id: 'base', state: 'unclaimed' }]);
  assert.equal(f.item('child').state, 'accepted');

  // 1. Unfinished prerequisite: prose, structured hint, project state and admission agree.
  const waiting = await f.call('room_read_work', { workItemId: 'child', brief: true });
  assert.match(waiting.brief, /Do not claim or start/);
  assert.equal(waiting.continuation.action, 'start');
  assert.equal(waiting.continuation.tool, null);
  assert.deepEqual(waiting.continuation.waitingOn, [{ id: 'base', state: 'unclaimed' }]);
  let state = await f.call('room_project_state');
  assert.equal(state.needsYou.some(entry => entry.id === 'child'), false);
  assert.equal(f.row(state, 'child').next, 'wait_prerequisites');
  assert.deepEqual(f.row(state, 'child').waitingOn, [{ id: 'base', state: 'unclaimed' }]);
  assert.throws(() => f.start('child'), error => error.code === 'work_claim_dependencies_unmet');

  // 6. No prerequisites: unchanged hint and row.
  const plain = await f.call('room_read_work', { workItemId: 'plain', brief: true });
  assert.equal(plain.continuation.tool, 'room_begin_work');
  assert.equal(Object.hasOwn(plain.continuation, 'waitingOn'), false);
  assert.equal(f.row(state, 'plain').next, 'accept');
  assert.equal(Object.hasOwn(f.row(state, 'plain'), 'waitingOn'), false);
  assert.equal(Object.hasOwn(state.inProgress.find(entry => entry.id === 'base') ?? {}, 'waitingOn'), false);

  // 2. Submitted evidence that still needs its required review does not release the dependent.
  await f.call('room_begin_work', { workItemId: 'base' });
  const completion = f.submit('base');
  const submitted = await f.call('room_read_work', { workItemId: 'child', brief: true });
  assert.equal(submitted.continuation.tool, null);
  assert.deepEqual(submitted.continuation.waitingOn, [{ id: 'base', state: 'delivered' }]);
  state = await f.call('room_project_state');
  assert.deepEqual(f.row(state, 'child').waitingOn, [{ id: 'base', state: 'delivered' }]);
  assert.throws(() => f.start('child'), error => error.code === 'work_claim_dependencies_unmet');

  // 7. Unchanged prerequisite facts keep the retained brief; the hint is still recomputed.
  const retained = await f.call('room_read_work', { workItemId: 'child', brief: true, knownBriefVersion: submitted.briefVersion });
  assert.equal(retained.briefUnchanged, true);
  assert.equal(retained.continuation.tool, null);

  // 3. The exact review releases it on a fresh read, with no edit to the dependent.
  const revision = f.item('child').revision;
  f.pass('base', completion);
  assert.equal(f.item('child').revision, revision);
  const ready = await f.call('room_read_work', { workItemId: 'child', brief: true, knownBriefVersion: submitted.briefVersion });
  assert.equal(ready.briefUnchanged, undefined, 'a prerequisite change refreshes the retained brief');
  assert.doesNotMatch(ready.brief, /Do not claim or start/);
  assert.equal(ready.continuation.tool, 'room_begin_work');
  assert.equal(Object.hasOwn(ready.continuation, 'waitingOn'), false);
  state = await f.call('room_project_state');
  assert.deepEqual(state.needsYou.find(entry => entry.id === 'child'), { id: 'child', next: 'start' });

  // 4. The read is advisory: the prerequisite changes after a ready read and admission still refuses.
  f.propose('replacement');
  f.send(f.owner, 'work.superseded', { workItemId: 'base', expectedRevision: f.item('base').revision, supersededByWorkItemId: 'replacement', reason: 'Continue in the replacement' });
  assert.throws(() => f.start('child'), error => error.code === 'work_claim_dependencies_unmet');
  const stale = await f.call('room_begin_work', { workItemId: 'child' });
  assert.equal(stale.stopped, 'waiting_on_prerequisites');
  assert.equal(f.item('child').state, 'accepted');
  assert.equal((await f.call('room_read_work', { workItemId: 'child', brief: true })).continuation.tool, null);
  assert.equal(f.row(await f.call('room_project_state'), 'child').next, 'wait_prerequisites');
});

test('native: a satisfied prerequisite lets the recommended begin reach working', async t => {
  const f = await nativeFixture(t);
  f.propose('base'); f.propose('child', { dependsOn: ['base'] });
  await f.call('room_begin_work', { workItemId: 'base' });
  f.submit('base');
  const ready = await f.call('room_read_work', { workItemId: 'child', brief: true });
  assert.equal(ready.continuation.tool, 'room_begin_work');
  assert.equal(Object.hasOwn(ready.continuation, 'waitingOn'), false);
  const begun = await f.call('room_begin_work', { workItemId: 'child' });
  assert.equal(begun.working, true);
  assert.equal(begun.stopped, null);
});

test('legacy Board room: the Board-owned prerequisite drives the same recommendation and release', async t => {
  const store = new RoomStore(':memory:');
  const identity = store.identities.create('Owen');
  store.initialize([event({ type: 'room.created', roomId: 'test-room', actorId: identity.identityId, data: { roomId: 'test-room', ownerId: identity.identityId, title: 'Dependencies', purpose: 'Historical Board' } }),
    event({ type: 'member.added', roomId: 'test-room', actorId: identity.identityId, data: { memberId: identity.identityId, identityId: identity.identityId, displayName: 'Owen', kind: 'agent', permissions: [...PERMISSIONS] } })]);
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('test-room', identity.identityId, identity.identityId, store.now());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.secret}` };
  const call = async (name, args = {}) => (await (await fetch(`${origin}/room/mcp?profile=full`, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'tools/call', params: { name, arguments: { roomId: 'test-room', ...args } } }) })).json()).result.structuredContent;
  const command = (type, data) => store.command(identity.secret, 'test-room', { id: crypto.randomUUID(), type, data });
  const client = new RoomAgentClient({ origin, roomId: 'test-room', token: identity.secret });
  await client.workClaimCreate({ id: 'base', reviewPolicy: 'self_attested' });
  command('work.proposed', { workItemId: 'child', title: 'child', definitionOfDone: 'Verified result', accountableMemberId: identity.identityId, mode: 'read', dependsOn: ['base'] });
  command('work.accepted', { workItemId: 'child', expectedRevision: 0 });
  const waiting = await call('room_read_work', { workItemId: 'child', brief: true });
  assert.match(waiting.brief, /Do not claim or start/);
  assert.equal(waiting.continuation.tool, null);
  assert.deepEqual(waiting.continuation.waitingOn, [{ id: 'base', state: 'unclaimed' }]);
  let state = await call('room_project_state');
  assert.equal(state.needsYou.some(entry => entry.id === 'child'), false);
  assert.equal(state.inProgress.find(entry => entry.id === 'child').next, 'wait_prerequisites');
  assert.throws(() => command('work.started', { workItemId: 'child', expectedRevision: 1 }), error => error.code === 'work_claim_dependencies_unmet');
  await client.claimWorkItem('base');
  await client.updateWorkItem('base', { state: 'in_progress' });
  await client.updateWorkItem('base', { state: 'done' });
  assert.equal((await call('room_read_work', { workItemId: 'child', brief: true })).continuation.tool, 'room_begin_work');
  state = await call('room_project_state');
  assert.equal(state.needsYou.find(entry => entry.id === 'child').next, 'start');
  command('work.started', { workItemId: 'child', expectedRevision: 1 });
  assert.equal(store.room('test-room').state.workItems.child.state, 'working');
});

test('unknown or withheld prerequisite information is never reported as ready', async () => {
  // A selected read without prerequisite observations: no execution hint.
  const context = { roomId: 'commons', viewer: { id: 'producer', active: true }, work: { id: 'task', revision: 2, mode: 'read' },
    next: { action: 'start', label: 'Start the work', memberId: 'producer', addressedToViewer: true }, suggestedActions: [{ action: 'start' }] };
  const unknown = workContinuation(context);
  assert.equal(unknown.tool, null);
  assert.equal(unknown.waitingOn, 'unknown');
  assert.equal(workContinuation({ ...context, dependencies: [] }).tool, 'room_begin_work');
  assert.equal(workContinuation({ ...context, dependencies: [{ id: 'gone', state: 'missing', satisfied: false }] }).tool, null);
  assert.deepEqual(prerequisiteHold([{ id: 'a', satisfied: true }, { id: 'b' }]).waitingOn, [{ id: 'b', state: 'unknown' }]);
  const many = prerequisiteHold(Array.from({ length: 5 }, (_, i) => ({ id: 'p' + i, state: 'unclaimed', satisfied: false })));
  assert.equal(many.waitingOn.length, 3); assert.equal(many.more, 2);

  // Begin leaves an absent observation to admission instead of guessing either way.
  const executed = [];
  const begin = dependencies => beginSelectedWork({ connected: true,
    read: async () => ({ work: { id: 'task', revision: 1, state: 'accepted', mode: 'read', accountableMemberId: 'producer' },
      viewer: { id: 'producer', active: true, permissions: ['accept_work', 'complete_work'] }, ...(dependencies ? { dependencies } : {}) }),
    execute: async stage => { executed.push(stage.action); return { status: 'refused', code: 'work_claim_dependencies_unmet' }; } });
  assert.equal((await begin([{ id: 'base', state: 'delivered', satisfied: false }])).stopped, 'waiting_on_prerequisites');
  assert.deepEqual(executed, []);
  assert.equal((await begin(null)).stopped, 'refused');
  assert.deepEqual(executed, ['room_start_work']);

  // Project state: bounded lookups can leave an item unexamined; a private task discloses no ids.
  const work = (id, extra = {}) => ({ id, title: id, state: 'accepted', revision: 1, mode: 'read', accountableMemberId: 'producer',
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', ...extra });
  const base = { roomId: 'r', viewerId: 'producer', ownerId: 'owner', sequence: 5, now: Date.UTC(2026, 10, 12, 1), live: {}, itemsComplete: true,
    members: { producer: { kind: 'agent' }, owner: { kind: 'human' } }, receipts: [], attention: [] };
  const items = [work('unexamined'), work('private', { title: null }), work('free')];
  const state = buildProjectState({ ...base, items, prerequisites: new Map([
    ['private', [{ id: 'secret-dependency', state: 'working', satisfied: false }]], ['free', []]]) });
  const row = id => state.inProgress.find(entry => entry.id === id);
  assert.equal(row('unexamined').next, 'check_prerequisites');
  assert.equal(row('unexamined').waitingOn, 'unknown');
  assert.ok(state.needsYou.some(entry => entry.id === 'unexamined'), 'unknown readiness still asks for a selected read');
  assert.equal(row('private').next, 'wait_prerequisites');
  assert.equal(row('private').waitingOn, 1);
  assert.doesNotMatch(JSON.stringify(state), /secret-dependency/);
  assert.equal(row('free').next, 'start');
  // Pure callers that supply no observations keep the previous document.
  assert.deepEqual(buildProjectState({ ...base, items: [work('free')] }), buildProjectState({ ...base, items: [work('free')], prerequisites: new Map([['free', []]]) }));
});
