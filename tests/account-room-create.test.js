import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createAccountRoom } from '../server/account-room-create.mjs';
import { createRoomServer } from '../server/http.mjs';

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'create-room-')), store = new RoomStore(join(path, 'room.sqlite'));
  t.after(() => { store.close(); rmSync(path, { recursive: true, force: true }); });
  store.createAccount('alice'); store.createAccount('bob');
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, store.issueAccountAccessKey('alice'), 0);
  const request = { requestId: crypto.randomUUID(), title: 'Design' };
  return { store, slot, session, request };
}

test('private room creation is owner-bound, idempotent and isolated', t => {
  const f = fixture(t), create = request => createAccountRoom(f.store, f.slot.token, f.session.sessionBinding, request);
  const first = create(f.request);
  assert.equal(first.duplicate, false);
  assert.equal(f.store.authenticateAccountSession(f.slot.token, first.roomId).member.id, 'owner');
  assert.deepEqual(Object.keys(f.store.room(first.roomId).state.members), ['owner']);
  assert.deepEqual(create(f.request), { ...first, duplicate: true });
  assert.throws(() => create({ ...f.request, title: 'Changed' }), { code: 'room_creation_conflict' });
  const replacement = f.store.loginAccountSession(f.slot.token, f.store.issueAccountAccessKey('bob'), 1);
  assert.throws(() => create(f.request), { code: 'session_binding_changed' });
  assert.throws(() => f.store.authenticateAccountSession(f.slot.token, first.roomId));
  const other = createAccountRoom(f.store, f.slot.token, replacement.sessionBinding, f.request);
  assert.notEqual(other.roomId, first.roomId);
});

test('creation validates names, caps owned rooms and permits exact retries at the cap', t => {
  const f = fixture(t), create = request => createAccountRoom(f.store, f.slot.token, f.session.sessionBinding, request);
  for (const title of ['', ' ', 'a'.repeat(81), 'bad\nname']) assert.throws(() => create({ ...f.request, title }), { status: 422 });
  const first = create(f.request);
  for (let i = 1; i < 10; i++) create({ requestId: crypto.randomUUID(), title: `Room ${i}` });
  assert.throws(() => create({ requestId: crypto.randomUUID(), title: 'Too many' }), { code: 'pilot_limit' });
  assert.deepEqual(create(f.request), { ...first, duplicate: true });
});

test('HTTP creation requires account session, CSRF and binding', async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = { method: 'POST', headers: { Origin: origin, Cookie: `account_session=${f.slot.token}`,
    'Content-Type': 'application/json', 'X-Session-Binding': f.session.sessionBinding }, body: JSON.stringify(f.request) };
  assert.equal((await fetch(origin + '/api/account-rooms', options)).status, 403);
  const result = await fetch(origin + '/api/account-rooms', { ...options, headers: { ...options.headers, 'X-CSRF-Token': f.session.csrf } });
  assert.equal(result.status, 201, await result.clone().text());
  assert.equal((await result.json()).duplicate, false);
});
