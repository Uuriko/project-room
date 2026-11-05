import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event,PERMISSIONS} from '../src/events.js';
import {buildActivationPack} from '../server/room-activation-pack.mjs';
import {readRoomSnapshot} from '../server/snapshot-window.mjs';

// R-05: store.currentOverview must use the scoped (addressed) authority so a
// current-format room with more than 100 TOTAL member records still returns
// an overview for a member viewer, instead of refusing through the full
// member census (409 current_room_context_unavailable).
const memberId = i => 'm' + String(i).padStart(3, '0');

function bigRoomEvents({ total = 101, deactivate = null, pin = false } = {}) {
  const events = initialRoom();
  for (let i = 1; i < total; i++) {
    const id = memberId(i);
    events.push(event({ id: 'add-' + id, type: 'member.added', actorId: 'owner', roomId: 'commons',
      data: { memberId: id, displayName: 'Member ' + id, kind: 'agent', permissions: [...PERMISSIONS] } }));
  }
  if (deactivate) {
    events.push(event({ id: 'deact-' + deactivate, type: 'member.access_changed', actorId: 'owner', roomId: 'commons',
      data: { memberId: deactivate, expectedMemberRevision: 0, active: false, permissions: [...PERMISSIONS] } }));
  }
  if (pin) {
    events.push(event({ id: 'post-pin', type: 'message.posted', actorId: 'owner', roomId: 'commons',
      data: { messageId: 'pinmsg', body: 'Pinned hello' } }));
    events.push(event({ id: 'pin-1', type: 'message.pinned', actorId: 'owner', roomId: 'commons',
      data: { messageId: 'pinmsg' } }));
  }
  return events;
}

function bigStore(t, options) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize(bigRoomEvents(options), { representation: 'normalized-current-v1' });
  return store;
}

test('R-05 falsifier: 101 total member records — currentOverview returns instead of refusing', t => {
  const store = bigStore(t, { total: 101 });
  const overview = store.currentOverview('commons', 'owner');
  assert.ok(overview, 'overview must return in a 101-total-record room');
  assert.equal(overview.state.room.id, 'commons');
  assert.ok(Object.hasOwn(overview.state.members, 'owner'));
});

test('R-05: a non-owner member viewer also gets a scoped overview in the 101-total room', t => {
  const store = bigStore(t, { total: 101 });
  const overview = store.currentOverview('commons', 'm050');
  assert.ok(Object.hasOwn(overview.state.members, 'm050'));
  assert.ok(Object.hasOwn(overview.state.members, 'owner'));
});

test('R-05: a non-member viewer is still refused member_required in the big room', t => {
  const store = bigStore(t, { total: 101 });
  assert.throws(() => store.currentOverview('commons', 'stranger'),
    e => e.status === 403 && e.code === 'member_required');
});

test('R-05 churn shape: 101 total / 100 active — overview returns and roomContext lists the active roster only', t => {
  const store = bigStore(t, { total: 101, deactivate: 'm100' });
  const overview = store.currentOverview('commons', 'owner');
  assert.ok(overview);
  const token = store.issueAccessKey('commons', 'owner');
  const context = store.roomContext(token, 'commons');
  assert.equal(context.roster.length, 100);
  assert.ok(context.roster.every(entry => entry.active === true));
  assert.ok(!context.roster.some(entry => entry.id === 'm100'), 'deactivated member must not appear in the active roster');
  assert.ok(context.roster.some(entry => entry.id === 'owner'));
  assert.ok(context.roster.some(entry => entry.id === 'm001'));
});

test('R-05 pins companion: pinned message stays visible through the scoped overview state', t => {
  const store = bigStore(t, { total: 101, deactivate: 'm100', pin: true });
  const overview = store.currentOverview('commons', 'owner');
  assert.ok(Array.isArray(overview.state.pins), 'scoped overview must still load pins');
  assert.deepEqual(overview.state.pins.map(p => p.messageId), ['pinmsg']);
});

test('R-05 roster companion: activation pack lists the active roster in the big room', t => {
  const store = bigStore(t, { total: 101, deactivate: 'm100' });
  const pack = buildActivationPack(store, 'commons', 'owner');
  assert.equal(pack.members.length, 100);
  assert.ok(!pack.members.some(member => member.id === 'm100'));
  assert.ok(pack.members.some(member => member.id === 'owner'));
});

test('R-05 roster companion: browser snapshot lists the active roster in the big room', t => {
  const store = bigStore(t, { total: 101, deactivate: 'm100' });
  const key = store.issueAccessKey('commons', 'owner');
  const snapshot = readRoomSnapshot(store, key, 'commons', null, { windowed: true });
  assert.equal(Object.keys(snapshot.state.members).length, 100);
  assert.ok(!Object.hasOwn(snapshot.state.members, 'm100'));
  assert.ok(Object.hasOwn(snapshot.state.members, 'owner'));
});

test('R-05 preserved limitation: no anonymous (viewerId=null) overview of a big room', t => {
  const store = bigStore(t, { total: 101 });
  assert.throws(() => buildActivationPack(store, 'commons', null),
    e => e.status === 409 && e.code === 'current_room_context_unavailable');
});
