import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {textVersion} from '../server/text-results.mjs';
import {buildActivationPack, briefActivationPack, BRIEF_BYTES} from '../server/room-activation-pack.mjs';
import {createHostedRoomMcp} from '../server/mcp-room-profile.mjs';

function fixture(t, {human = false} = {}) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const identity = store.identities.create('Activation agent');
  const events = initialRoom();
  events[1].data.identityId = identity.identityId;
  events[1].data.kind = human ? 'human' : 'agent';
  store.initialize(events, {representation: 'normalized-current-v1'});
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)')
    .run('commons', identity.identityId, 'owner', new Date(store.now()).toISOString());
  const key = store.issueAccessKey('commons', 'owner');
  const send = (type, data) => store.command(key, 'commons', {id: crypto.randomUUID(), type, data});
  store.room = () => { throw Error('whole-room hydration forbidden'); };
  const mcp = createHostedRoomMcp(store);
  const call = async (name, args = {}) => {
    const response = await mcp({jsonrpc: '2.0', id: 'activation', method: 'tools/call',
      params: {name, arguments: {roomId: 'commons', ...args}}}, {authorization: `Bearer ${identity.secret}`});
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.notEqual(response.result.isError, true, JSON.stringify(response));
    return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
  };
  return {store, send, call};
}

test('normalized MCP brief retains current charter purpose, provenance and explicit clearing without writes', async t => {
  const f = fixture(t);
  f.send('room.charter_updated', {expectedRevision: 0, purpose: 'Make useful contributions', outputs: null, boundaries: null, escalation: null});
  const before = f.store.headSequence('commons');
  const brief = await f.call('room_activation_pack', {view: 'brief'});
  assert.equal(brief.purpose, 'Make useful contributions');
  assert.equal(brief.purposeSource.authority, 'context_only');
  assert.equal(brief.purposeSource.revision, 1);
  assert.ok(brief.purposeSource.eventId);
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= BRIEF_BYTES);
  assert.equal(f.store.headSequence('commons'), before);
  f.send('room.charter_updated', {expectedRevision: 1, purpose: null, outputs: null, boundaries: null, escalation: null});
  const cleared = await f.call('room_activation_pack', {view: 'brief'});
  assert.equal(cleared.purpose, '');
  assert.equal(cleared.purposeSource.revision, 2);
});

test('empty filtered activation page retains cursor and directs agents to addressed work, not global absence', async t => {
  const f = fixture(t);
  const propose = id => f.send('work.proposed', {workItemId: id, title: id, definitionOfDone: 'Useful result', accountableMemberId: 'owner', mode: 'read'});
  propose('z-open');
  for (let i = 0; i < 8; i++) {
    const id = `a-history-${i}`;
    propose(id);
    complete(f, id);
  }
  const before = f.store.headSequence('commons');
  const brief = await f.call('room_activation_pack', {view: 'brief'});
  assert.deepEqual(brief.pickUp, []);
  assert.equal(brief.workWindow.complete, false);
  assert.ok(brief.workWindow.nextAfter);
  assert.equal(brief.next.endpoint, '/api/rooms/commons/work-list?focus=all');
  assert.doesNotMatch(brief.next.why, /nothing open/);
  const page = buildActivationPack(f.store, 'commons', 'owner', {workAfter: brief.workWindow.nextAfter});
  assert.equal(page.openWork[0].id, 'z-open');
  assert.equal(f.store.headSequence('commons'), before);
});

test('empty normalized activation offers an authorized work read without claiming global absence', async t => {
  const f = fixture(t);
  const pack = buildActivationPack(f.store, 'commons', 'owner');
  const brief = briefActivationPack(pack, [], f.store.now(), 'owner');
  assert.equal(brief.purpose, '');
  assert.equal(brief.next.endpoint, '/api/rooms/commons/work-list?focus=needs_me');
  assert.doesNotMatch(brief.next.why, /nothing open/);
  await f.call('room_list_work', {focus: 'needs_me'});
});

test('an owned write claim is not mistaken for absence when activation selects no pickup', async t => {
  const f = fixture(t);
  f.send('work.proposed', {workItemId: 'owned', title: 'Continue owned work', definitionOfDone: 'Saved result', accountableMemberId: 'owner', mode: 'write'});
  f.send('work.accepted', {workItemId: 'owned', expectedRevision: 0});
  f.send('claim.acquired', {workItemId: 'owned', expectedRevision: 1, repository: 'example/project', ref: 'main', paths: ['src'], expiresAt: new Date(f.store.now() + 3600000).toISOString()});
  const brief = await f.call('room_activation_pack', {view: 'brief'});
  assert.deepEqual(brief.pickUp, []);
  assert.equal(brief.next.endpoint, '/api/rooms/commons/work-context?workItemId=owned');
  const work = await f.call('room_list_work', {focus: 'needs_me'});
  assert.match(JSON.stringify(work), /Continue owned work/);
});

function complete(f, id) {
  f.send('work.accepted', {workItemId: id, expectedRevision: 0});
  f.send('work.started', {workItemId: id, expectedRevision: 1});
  const body = `Saved result for ${id}`;
  const posted = f.send('message.posted', {messageId: `result-${id}`, workItemId: id, body});
  f.send('work.completed', {workItemId: id, expectedRevision: 2, evidenceKind: 'room_text',
    evidenceMessageId: `result-${id}`, evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: 'owner', summary: 'Saved result', nextAction: 'Review'});
}

test('no pickup still points the owner to a pending acceptance decision', async t => {
  const f = fixture(t, {human: true});
  f.send('work.proposed', {workItemId: 'decision', title: 'Inspect submitted result', definitionOfDone: 'Saved result',
    accountableMemberId: 'owner', humanDecisionMakerId: 'owner', mode: 'read', ownerDecisionRequired: true});
  complete(f, 'decision');
  const brief = await f.call('room_activation_pack', {view: 'brief'});
  assert.deepEqual(brief.pickUp, []);
  assert.equal(brief.next.endpoint, '/api/rooms/commons/work-context?workItemId=decision');
  const work = await f.call('room_list_work', {focus: 'needs_me'});
  assert.match(JSON.stringify(work), /Inspect submitted result/);
});
