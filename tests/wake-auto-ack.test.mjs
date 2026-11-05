import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {acknowledgeOnDelivery, autoAckCommand} from '../server/wake-ack.mjs';

function fixture(t) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const es = initialRoom();
  for (const id of ['asker', 'helper']) es.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: id, displayName: id, kind: 'agent', permissions: ['accept_work', 'complete_work']}}));
  s.initialize(es);
  const keys = Object.fromEntries(['owner', 'asker', 'helper'].map(id => [id, s.issueAccessKey('commons', id)]));
  s.command(keys.asker, 'commons', {id: 'ask', type: 'message.posted', data: {messageId: 'ask', toMemberId: 'helper', requestKind: 'reply', body: 'Can you check the deploy?'}});
  const list = who => s.replyRequests.list(keys[who], 'commons', {direction: 'both', status: 'all'}).requests.find(r => r.id === 'ask');
  const submitAs = who => c => s.command(keys[who], 'commons', c);
  return {list, submitAs};
}

test('delivered wake records acknowledged progress once, as the recipient', t => {
  const {list, submitAs} = fixture(t);
  assert.equal(acknowledgeOnDelivery({roomId: 'commons', request: list('helper'), delivered: false, submit: submitAs('helper')}).acked, false);
  const first = acknowledgeOnDelivery({roomId: 'commons', request: list('helper'), delivered: true, submit: submitAs('helper')});
  assert.equal(first.acked, true);
  const seen = list('asker');
  assert.equal(seen.status, 'open');
  assert.equal(seen.revision, 0);
  assert.equal(seen.progress.state, 'acknowledged');
  // A retried delivery is a no-op: progress already exists.
  assert.equal(acknowledgeOnDelivery({roomId: 'commons', request: list('helper'), delivered: true, submit: submitAs('helper')}).reason, 'not_due');
});

test('ack is stable per request revision and never throws into delivery', t => {
  const {list, submitAs} = fixture(t);
  const r = list('helper');
  assert.equal(autoAckCommand('commons', r).id, autoAckCommand('commons', r).id);
  assert.equal(autoAckCommand('commons', {...r, status: 'answered'}), null);
  const wrong = acknowledgeOnDelivery({roomId: 'commons', request: r, delivered: true, submit: submitAs('asker')});
  assert.equal(wrong.acked, false);
  assert.match(wrong.reason, /recipient/);
});
