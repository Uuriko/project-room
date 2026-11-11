import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event, EVENT_TYPES as T} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';

// QA Round 1 defect 5: after room.public_receipts_set succeeds on a
// normalized room, the next plain message.posted refused 409
// current_room_context_unavailable ("Published/starter room dependencies
// require qualification"). Chat posts neither read nor change receipts.
function room(t) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const log = initialRoom();
  log.push(event({roomId: 'commons', actorId: 'owner', type: T.MEMBER_ADDED, data: {memberId: 'agent', displayName: 'Agent', kind: 'agent', permissions: ['steer']}}));
  s.initialize(log, {representation: 'normalized-current-v1'});
  return {s, owner: s.issueAccessKey('commons', 'owner'), agent: s.issueAccessKey('commons', 'agent')};
}

test('a receipts-on normalized room accepts plain and mention posts and stays replay-exact', t => {
  const {s, owner, agent} = room(t);
  s.command(owner, 'commons', {id: 'receipts-on', type: T.ROOM_PUBLIC_RECEIPTS_SET, data: {enabled: true}});
  const receiptsBefore = s.db.prepare('SELECT count(*) n FROM public_receipts').get().n;
  s.command(owner, 'commons', {id: 'plain', type: T.MESSAGE_POSTED, data: {messageId: 'plain', body: 'hello after opt-in'}});
  s.command(agent, 'commons', {id: 'mention', type: T.MESSAGE_POSTED, data: {messageId: 'mention', body: '@Agent noted, thanks'}});
  assert.equal(s.db.prepare('SELECT count(*) n FROM public_receipts').get().n, receiptsBefore);
  assert.doesNotThrow(() => auditRecovery(s));
});

test('commands outside the qualified work chain still need qualification', t => {
  const {s, owner} = room(t);
  s.command(owner, 'commons', {id: 'receipts-on', type: T.ROOM_PUBLIC_RECEIPTS_SET, data: {enabled: true}});
  assert.throws(() => s.command(owner, 'commons', {id: 'channel', type: T.CHANNEL_CREATED, data: {channelId: 'side', name: 'side'}}),
    err => err.code === 'current_room_context_unavailable');
});
