// Open work in room_needs_me. Measured in muse-room on 2026-10-05 (GET
// /work-claims history, 203 claims): 21 of 21 items posted for another agent to
// pick up were never claimed, the oldest 88h, because room_needs_me (the read
// every agent polls) never listed unclaimed work. openWork is standing state:
// it rides beside items and must not move the cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';
import { createWork, claimWork } from '../server/work-claims.mjs';

const WRITER = ['steer', 'accept_work', 'complete_work', 'verify'];

function setup(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen');
  const ada = store.identities.create('Ada');
  const rex = store.identities.create('Rex');
  rooms.create(owner.secret, { roomId: 'board', title: 'board', purpose: 'Open work', kind: 'personal' });
  store.identities.link(owner.secret, 'board', { identityId: ada.identityId, displayName: 'Ada', permissions: WRITER });
  store.identities.link(owner.secret, 'board', { identityId: rex.identityId, displayName: 'Rex', permissions: [] });
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const put = (id, minutes, extra = {}) => {
    const item = { ...createWork({ id, title: `Task ${id}`, tags: ['wk41'], ...extra }, { now: t0 + minutes * 60000, agentId: owner.identityId }) };
    store.workClaims.set('board', item);
    return item;
  };
  return { store, owner, ada, rex, put, t0 };
}

test('an idle writer sees ready unclaimed work in Board order, without new events', t => {
  const { store, ada, put, owner } = setup(t);
  const first = collectNeedsMe(store, ada.secret, {});
  assert.equal(first.openWork, undefined, 'empty board adds nothing');
  put('newer', 30);
  put('oldest', 0);
  put('middle', 10);
  put('blocked', 1, { dependsOn: ['middle'] });
  const taken = claimWork(put('taken', 2), owner.identityId, { now: Date.now() });
  store.workClaims.set('board', taken);
  const page = collectNeedsMe(store, ada.secret, { since: first.cursor });
  assert.equal(page.items.length, 0, 'nothing new addressed to Ada');
  assert.equal(page.openWork?.length, 1);
  const open = page.openWork[0];
  assert.equal(open.roomId, 'board');
  assert.equal(open.count, 3, 'claimed and dependency-blocked items are not open');
  assert.deepEqual(open.top.map(row => row.id), ['newer', 'middle', 'oldest'], 'Board order: most recently updated first');
  assert.ok(open.top[0].idleMinutes < open.top[2].idleMinutes);
  assert.equal(open.oldestIdleMinutes, open.top[2].idleMinutes);
  assert.deepEqual(open.top[0].tags, ['wk41']);
  assert.match(open.next, /^POST \/api\/rooms\/board\/work-claims\/\{id\}\/claim$/);
  assert.deepEqual(page.cursor, collectNeedsMe(store, ada.secret, { since: first.cursor }).cursor, 'openWork never moves the cursor');
});

test('a dependency that is done makes its dependent ready', t => {
  const { store, ada, put } = setup(t);
  const dep = put('dep', 0);
  put('after', 5, { dependsOn: ['dep'] });
  store.workClaims.set('board', { ...dep, state: 'done' });
  const open = collectNeedsMe(store, ada.secret, {}).openWork[0];
  assert.deepEqual(open.top.map(row => row.id), ['after']);
});

test('work posted for pickup ranks above released work', t => {
  const { store, ada, owner, put } = setup(t);
  put('posted', 0);
  const claimed = claimWork(put('handed-back', 5), owner.identityId, { now: Date.now() });
  store.workClaims.set('board', { ...claimed, state: 'unclaimed', owner: null,
    history: [...claimed.history, { at: new Date().toISOString(), agentId: owner.identityId, action: 'state:unclaimed' }] });
  const open = collectNeedsMe(store, ada.secret, {}).openWork[0];
  assert.equal(open.count, 2);
  assert.equal(open.neverClaimed, 1);
  assert.deepEqual(open.top.map(row => [row.id, row.released ?? false]), [['posted', false], ['handed-back', true]]);
});

test('Board order uses the exact timestamp, not the rounded minute', t => {
  const { store, ada, owner } = setup(t);
  const base = Date.parse('2026-10-01T00:00:00Z');
  // Same minute, 10 s apart: the later one is first in Board order even though
  // its id sorts after the earlier one.
  store.workClaims.set('board', createWork({ id: 'a-earlier', title: 'A' }, { now: base, agentId: owner.identityId }));
  store.workClaims.set('board', createWork({ id: 'z-later', title: 'Z' }, { now: base + 10000, agentId: owner.identityId }));
  const open = collectNeedsMe(store, ada.secret, {}).openWork[0];
  assert.deepEqual(open.top.map(row => row.id), ['z-later', 'a-earlier']);
  assert.ok(open.top[1].idleMinutes - open.top[0].idleMinutes <= 1, 'display minutes differ by at most rounding; order is still exact');
});

test('every room with open work is summarised, none dropped', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const ada = store.identities.create('Ada');
  for (let r = 0; r < 14; r++) {
    const roomId = `room-${String(r).padStart(2, '0')}`;
    const owner = store.identities.create(`Owen ${r}`);
    rooms.create(owner.secret, { roomId, title: roomId, purpose: 'Open work', kind: 'personal' });
    store.identities.link(owner.secret, roomId, { identityId: ada.identityId, displayName: 'Ada', permissions: WRITER });
    store.workClaims.set(roomId, createWork({ id: `task-${r}`, title: 'T' }, { now: Date.now(), agentId: owner.identityId }));
  }
  const page = collectNeedsMe(store, ada.secret, {});
  assert.equal(page.openWork.length, 14);
});

test('members who cannot claim see no openWork', t => {
  const { store, rex, put } = setup(t);
  put('a', 0);
  assert.equal(collectNeedsMe(store, rex.secret, {}).openWork, undefined);
});

test('openWork stays small on a crowded board', t => {
  const { store, ada, put } = setup(t);
  for (let i = 0; i < 40; i++) put(`task-${String(i).padStart(2, '0')}`, i, { title: 'x'.repeat(400) });
  const open = collectNeedsMe(store, ada.secret, {}).openWork[0];
  assert.equal(open.count, 40);
  assert.equal(open.top.length, 3);
  assert.ok(open.top.every(row => row.title.length <= 80));
  assert.ok(JSON.stringify(open).length < 600, `openWork was ${JSON.stringify(open).length} bytes`);
});
