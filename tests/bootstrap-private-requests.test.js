import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { readRoomSnapshot } from '../server/snapshot-window.mjs';

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.guest, 'commons', { id: 'private-request', type: 'message.posted', data: {
    messageId: 'private-request', requestKind: 'reply', toMemberId: 'producer', body: 'Private subject'
  } });
  f.store.command(f.keys.owner, 'commons', { id: 'ordinary-public', type: 'message.posted', data: { messageId: 'ordinary-public', body: 'Public subject' } });
  const get = (member, suffix = '/bootstrap') => fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons${suffix}`, { headers: { Authorization: `Bearer ${f.keys[member]}` } });
  return { ...f, get };
}

test('bootstrap and ordinary snapshots hide private request metadata from outsiders including room owner', async t => {
  const f = await fixture(t);
  for (const member of ['reviewer', 'owner']) {
    assert.throws(() => f.store.replyRequests.selected(f.keys[member], 'commons', 'private-request'), { status: 404 });
    for (const suffix of ['/bootstrap', '']) {
      const response = await f.get(member, suffix);
      assert.equal(response.status, 200);
      const body = await response.json(), snapshot = body.snapshot ?? body;
      assert.equal(Object.hasOwn(snapshot.state.replyRequests, 'private-request'), false);
      assert.equal(JSON.stringify(body).includes('private-request'), false);
      assert.ok(snapshot.state.messages.some(message => message.id === 'ordinary-public'));
    }
  }
  assert.ok(f.store.room('commons').state.replyRequests['private-request'], 'canonical state is unchanged');
});

test('bootstrap retains both participants request metadata independently of recent message window', async t => {
  const f = await fixture(t);
  f.store.roomFlood = { consume() {} };
  for (let i = 0; i < 105; i++) f.store.command(f.keys.owner, 'commons', { id: `later-${i}`, type: 'message.posted', data: { messageId: `later-${i}`, body: 'Later public message' } });
  for (const member of ['guest', 'producer']) {
    const response = await f.get(member), body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.snapshot.state.replyRequests['private-request']);
    assert.equal(body.snapshot.state.messages.some(message => message.id === 'private-request'), false);
  }
});

test('request metadata respects participant history floor and revoked membership', async t => {
  const f = await fixture(t), original = f.store.historyFloor.bind(f.store);
  f.store.historyFloor = (roomId, memberId, ...rest) => memberId === 'producer'
    ? { sequence: 999999, at: '9999-01-01T00:00:00.000Z', sameInstant: new Set() } : original(roomId, memberId, ...rest);
  assert.equal(Object.hasOwn(readRoomSnapshot(f.store, f.keys.producer, 'commons', null).state.replyRequests, 'private-request'), false);
  f.store.command(f.keys.owner, 'commons', { id: 'remove-producer', type: 'member.access_changed', data: { memberId: 'producer', expectedMemberRevision: f.store.room('commons').state.members.producer.revision, permissions: [], active: false } });
  assert.notEqual((await f.get('producer')).status, 200);
});
