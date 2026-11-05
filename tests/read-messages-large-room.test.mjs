// Regression: room_read_messages {latest:true} returned 409
// current_room_context_unavailable on prod (project-room-lobby). The latest
// walk needs only the head sequence, but roomMessages read it through
// store.roomAuthority(roomId), which assembles the full member census
// (record + witness receipt per member) inside the shared 200-record/256KiB
// current read budget. It failed from ~20 members. The same pattern sat in
// readEventTail (GET events?tail=). Both now use store.headSequence(), one
// primary-key read whose cost does not grow with member count.
import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNeedsMeRoom} from './helpers/canonical-needs-me-room.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {callHostedStdioTool} from '../server/mcp-full-profile.mjs';
import {readEventTail} from '../server/updates.mjs';

function bigRoom(t, members) {
  const f = canonicalNeedsMeRoom(t), {store, owner, roomId} = f;
  for (let n = 0; n < members; n++) {
    const id = store.identities.create('Member ' + n);
    linkWithProof(store, owner.secret, roomId, id, {displayName: ('Member ' + n + ' ').padEnd(80, 'x'), permissions: ['accept_work']});
  }
  for (let i = 0; i < 30; i++) f.send(owner, 'message.posted', {messageId: 'm' + String(i).padStart(2, '0'), body: 'hello ' + i});
  return f;
}

test('latest message read works in a 95-member room and returns the newest page', async t => {
  const {store, worker, roomId} = bigRoom(t, 95);
  for (const limit of [8, 25]) {
    const {value, isError} = await callHostedStdioTool(store, worker.secret, 'room_read_messages', {roomId, latest: true, limit});
    assert.equal(isError, false);
    assert.equal(value.messages.length, limit);
    assert.equal(value.messages.at(-1).messageId, 'm29');
    const forward = (await callHostedStdioTool(store, worker.secret, 'room_read_messages', {roomId, limit: 100})).value.messages;
    assert.deepEqual(value.messages.map(m => m.messageId), forward.slice(-limit).map(m => m.messageId));
  }
  assert.equal(store.headSequence(roomId), store.roomAuthority(roomId, {memberId: worker.identityId}).sequence);
});

test('event tail read works in a 95-member room', t => {
  const {store, worker, roomId} = bigRoom(t, 95);
  const page = readEventTail(store, worker.secret, roomId, 10);
  assert.ok(page.events.length > 0 && page.events.length <= 10);
  assert.equal(page.events.at(-1).sequence, store.headSequence(roomId));
  assert.equal(page.events.at(-1).event.data.messageId, 'm29');
});
