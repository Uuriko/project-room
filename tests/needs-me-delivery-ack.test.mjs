import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {collectNeedsMe} from '../server/needs-me.mjs';
function fixture(t) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const olive = store.identities.create('Olive'), parker = store.identities.create('Parker'), roomId = 'delivery-ack';
  new AgentRooms(store).create(olive.secret, {roomId, title: 'Delivery acknowledgement', purpose: 'Synthetic test', starter: false});
  store.invites.redeem(store.invites.create(olive.secret, roomId, {profile: 'member'}).code,
    {identitySecret: parker.secret, displayName: 'Parker'});
  store.dmConsents.request(roomId, parker.identityId, olive.identityId, 'Reply coordination');
  store.dmConsents.decide(roomId, olive.identityId, parker.identityId, 'approve');
  store.command(parker.secret, roomId, {id: 'ask', type: 'message.posted',
    data: {messageId: 'ask', toMemberId: olive.identityId, requestKind: 'reply', body: 'Please check deployment'}});
  const read = (claimSec = 45) => collectNeedsMe(store, olive.secret, {roomId, claimSec});
  const request = () => store.replyRequests.list(olive.secret, roomId, {direction: 'incoming', status: 'open'}).requests.find(r => r.id === 'ask');
  const ack = who => store.command(who.secret, roomId, {id: 'explicit-ack', type: 'reply_request.progressed',
    data: {requestMessageId: 'ask', expectedRequestRevision: 0, progress: 'acknowledged'}});
  return {store, roomId, olive, parker, read, request, ack};
}
const hasAsk = page => page.items.some(i => i.kind === 'direct_ask' && i.id === 'ask');
for (const claimSec of [0, 45]) test(`needs-me delivery does not acknowledge an ask (lease ${claimSec}s)`, t => {
  const f = fixture(t); assert.ok(hasAsk(f.read(claimSec)));
  assert.equal(f.request().progress, undefined);
  assert.equal(f.request().status, 'open');
});
test('duplicate handler is lease-suppressed without acknowledging the ask', t => {
  const f = fixture(t); assert.ok(hasAsk(f.read()));
  assert.equal(hasAsk(f.read()), false);
  assert.equal(f.request().progress, undefined);
});
test('lost response can redeliver after lease expiry without fabricating ACK', t => {
  const f = fixture(t);
  f.read(); // Response is lost: no caller disposition and no saved cursor.
  assert.equal(f.request().progress, undefined);
  f.store.db.prepare('UPDATE needs_me_claims SET expires_at=0 WHERE room_id=?').run(f.roomId);
  assert.ok(hasAsk(f.read()));
  assert.equal(f.request().progress, undefined);
});
test('explicit recipient acknowledgement still works and is idempotent', t => {
  const f = fixture(t); f.read();
  assert.throws(() => f.ack(f.parker), /recipient/);
  f.ack(f.olive); f.ack(f.olive);
  assert.equal(f.request().progress.state, 'acknowledged');
  assert.equal(f.request().revision, 0);
  assert.equal(f.request().status, 'open');
});
