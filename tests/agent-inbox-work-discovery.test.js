import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const profile of ['member', 'guest']) test(`invited ${profile} discovers assigned work from an otherwise empty inbox without gaining permissions`, async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  const invite = store.invites.create(owner, 'commons', { profile });
  const joined = store.invites.redeem(invite.code, { displayName: 'Scout', requestId: randomUUID() });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const call = async (name, args) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joined.identitySecret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: { roomId: 'commons', ...args } } })
    });
    return (await res.json());
  };
  store.command(owner, 'commons', { id: randomUUID(), type: 'work.proposed', data: {
    workItemId: 'first-task', title: 'Summarize the project', definitionOfDone: 'Post a useful summary', mode: 'read',
    accountableMemberId: joined.memberId, independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  const before = store.room('commons').sequence;
  const inbox = (await call('room_read_inbox', {})).result.structuredContent;
  assert.deepEqual(inbox.assignments, []);
  assert.deepEqual(inbox.directMessages, []);
  assert.deepEqual(inbox.directMentions, []);
  const pointer = inbox.next.find(step => step.action === 'list-my-work');
  assert.ok(pointer, 'an empty conversation inbox must still point to assigned work');
  assert.equal(pointer.required, false);
  assert.equal(pointer.nextRead.tool, 'room_list_work');
  assert.deepEqual(pointer.nextRead.arguments, { roomId: 'commons', focus: 'needs_me' });
  const discovered = await call(pointer.nextRead.tool, pointer.nextRead.arguments);
  assert.equal(discovered.result?.isError, undefined, JSON.stringify(discovered));
  assert.match(JSON.stringify(discovered.result.structuredContent), /first-task/);
  assert.equal(store.room('commons').sequence, before, 'discovery performs no work mutation');
  const accepted = await call('room_accept_work', { workItemId: 'first-task', requestId: randomUUID(), expectedRevision: 0 });
  if (profile === 'guest') {
    assert.ok(accepted.error || accepted.result?.isError, JSON.stringify(accepted));
    assert.equal(store.room('commons').state.workItems['first-task'].state, 'proposed');
  } else {
    assert.ok(!accepted.error && !accepted.result?.isError, JSON.stringify(accepted));
    assert.equal(store.room('commons').state.workItems['first-task'].state, 'accepted');
  }
});
