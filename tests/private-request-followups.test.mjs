import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';

// A formal request is addressed, so its body is visible only to the two
// parties. Its cancellation reason must be just as private; it was readable
// by every member through the event log.
for (const representation of [null, 'normalized-current-v1']) test(`a request's cancellation reason stays with its parties (${representation ?? 'legacy'})`, t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const es = initialRoom();
  for (const id of ['asker', 'helper', 'other']) es.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: id, displayName: id, kind: 'agent', permissions: ['accept_work']}}));
  s.initialize(es, representation ? {representation} : undefined);
  const keys = Object.fromEntries(['owner', 'asker', 'helper', 'other'].map(id => [id, s.issueAccessKey('commons', id)]));
  s.command(keys.asker, 'commons', {id: 'ask', type: 'message.posted', data: {messageId: 'ask', toMemberId: 'helper', requestKind: 'reply', body: 'PRIVATE-ASK'}});
  s.command(keys.asker, 'commons', {id: 'cancel', type: 'reply_request.cancelled', data: {requestMessageId: 'ask', expectedRequestRevision: 0, reason: 'PRIVATE-REASON'}});
  s.command(keys.owner, 'commons', {id: 'public', type: 'message.posted', data: {messageId: 'public', body: 'Public note'}});
  const seen = who => JSON.stringify(s.eventsAfter(keys[who], 'commons', 0, 100));
  for (const party of ['asker', 'helper']) assert.ok(seen(party).includes('PRIVATE-REASON'), party + ' sees the reason');
  for (const outsider of ['other', 'owner']) {
    const page = seen(outsider);
    assert.equal(page.includes('PRIVATE-ASK'), false, outsider + ' cannot see the request');
    assert.equal(page.includes('PRIVATE-REASON'), false, outsider + ' cannot see its cancellation');
    assert.ok(page.includes('Public note'), outsider + ' still sees public messages');
  }
});
