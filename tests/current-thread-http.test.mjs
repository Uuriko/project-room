import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { withCurrentRoomWriter } from '../server/current-room-repository.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t, { count = 0, replies = 3, sinceJoin = false } = {}) {
  const store = new RoomStore(':memory:'), events = initialRoom();
  const add = (type, data, actorId = 'owner') => events.push(event({ roomId: 'commons', actorId, type, data }));
  for (const id of ['alice', 'bob', 'mallory']) add('member.added', { memberId: id, displayName: id.toUpperCase(), kind: 'agent', permissions: [] });
  if (sinceJoin) add('room.history_visibility_set', { historyVisibility: 'since_join' });
  for (let i = 0; i < count; i++) add('message.posted', { messageId: 'unrelated-' + i, body: 'Unrelated room material ' + i });
  add('message.posted', { messageId: 'dm-root', body: 'Selected private request', toMemberId: 'bob' }, 'alice');
  for (let i = 0; i < replies; i++) add('message.posted', { messageId: 'dm-reply-' + i, body: 'Reply ' + i, replyToId: i === 1 ? 'dm-reply-0' : 'dm-root', toMemberId: i % 2 ? 'bob' : 'alice' }, i % 2 ? 'alice' : 'bob');
  add('message.posted', { messageId: 'public-root', body: 'Public selected root' });
  add('message.posted', { messageId: 'public-reply', body: 'Visible reply', replyToId: 'public-root' }, 'mallory');
  add('message.posted', { messageId: 'hidden-reply', body: 'Hidden reply', replyToId: 'public-root', toMemberId: 'bob' }, 'alice');
  add('message.posted', { messageId: 'public-after-hole', body: 'Visible later reply', replyToId: 'public-root' }, 'mallory');
  add('member.added', { memberId: 'late', displayName: 'LATE', kind: 'agent', permissions: [] });
  store.initialize(events, { representation: 'normalized-current-v1' });
  const keys = Object.fromEntries(['owner', 'alice', 'bob', 'mallory', 'late'].map(id => [id, store.issueAccessKey('commons', id)]));
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const read = async (actor, messageId, roomId = 'commons') => { const r = await fetch(`${origin}/api/rooms/${roomId}/messages/${messageId}/thread`, { headers: { authorization: 'Bearer ' + keys[actor] } }); return { status: r.status, value: await r.json() }; };
  return { store, keys, read };
}

test('normalized selected DM thread reads protected current messages without room hydration and preserves selected subtree', async t => {
  const f = await fixture(t, { count: 1000 });
  const root = await f.read('bob', 'dm-root');
  assert.equal(root.status, 200, JSON.stringify(root.value));
  f.store.room = () => { throw Error('Whole-room hydration forbidden'); };
  assert.equal((await f.read('bob', 'dm-root')).status, 200);
  assert.equal(root.value.thread.id, 'dm-root'); assert.equal(root.value.thread.body, 'Selected private request');
  assert.equal(root.value.thread.author, 'ALICE');
  assert.deepEqual(root.value.thread.replies.map(m => m.id), ['dm-reply-0', 'dm-reply-2']);
  assert.deepEqual(root.value.thread.replies[0].replies.map(m => m.id), ['dm-reply-1']);
  const selected = await f.read('alice', 'dm-reply-0');
  assert.equal(selected.status, 200); assert.equal(selected.value.thread.id, 'dm-reply-0');
  assert.deepEqual(selected.value.thread.replies.map(m => m.id), ['dm-reply-1']);
  for (const actor of ['mallory', 'owner']) assert.equal((await f.read(actor, 'dm-root')).status, 404);
  const pub = await f.read('mallory', 'public-root'); assert.equal(pub.status, 200);
  assert.deepEqual(pub.value.thread.replies.map(m => m.id), ['public-reply', 'public-after-hole']);
  assert.ok(!JSON.stringify(pub.value).includes('Hidden reply'));
  assert.ok(!JSON.stringify(pub.value).includes('hidden-reply'));
  assert.equal((await f.read('bob', 'absent')).status, 404);
  assert.notEqual((await f.read('bob', 'dm-root', 'wrong-room')).status, 200);
  f.store.revokeRoomCredential('commons', 'bob', f.keys.bob);
  assert.notEqual((await f.read('bob', 'dm-root')).status, 200);
});

test('normalized thread read refuses oversized context and protected row tampering without fallback hydration', async t => {
  const f = await fixture(t, { replies: 30 });
  f.store.room = () => { throw Error('Whole-room hydration forbidden'); };
  const large = await f.read('bob', 'dm-root');
  assert.equal(large.status, 413, JSON.stringify(large.value));
  // Bypass the write guard only in the fault fixture; the read proof must fail.
  f.store.transaction(() => withCurrentRoomWriter(f.store.db, 'commons', () => f.store.db.prepare("UPDATE messages SET body='tampered' WHERE room_id='commons' AND message_id='public-root'").run()));
  const corrupt = await f.read('mallory', 'public-root');
  assert.notEqual(corrupt.status, 200); assert.ok(!JSON.stringify(corrupt.value).includes('tampered'));
});


test('current selected thread preserves the since-join floor', async t => {
  const f = await fixture(t, { sinceJoin: true });
  f.store.room = () => { throw Error('Whole-room hydration forbidden'); };
  assert.equal((await f.read('late', 'public-root')).status, 404);
  assert.equal((await f.read('owner', 'public-root')).status, 200);
});

// Derived-index upgrade: no normalized record, carrier or format rewrite.
test('thread visibility indexes install on cold existing stores and rebuild exactly through restore', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { exportNdjsonText } = await import('../server/room-export.mjs');
  const { replayNdjsonInto } = await import('../server/restore-ndjson.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'thread-index-upgrade-')), path = join(dir, 'room.sqlite');
  let store = new RoomStore(path); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const events = initialRoom(); events.push(event({ roomId: 'commons', actorId: 'owner', type: 'message.posted', data: { messageId: 'root', body: 'Upgrade preserved' } }));
  store.initialize(events, { representation: 'normalized-current-v1' }); const key = store.issueAccessKey('commons', 'owner');
  const before = { head: store.db.prepare('SELECT * FROM current_room_head').all(), projection: store.db.prepare('SELECT projection FROM rooms').all() };
  const indexes = () => store.db.prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB 'current_messages_thread_*' ORDER BY name").all();
  for (const row of indexes()) store.db.exec('DROP INDEX ' + row.name);
  store.close(); store = new RoomStore(path);
  assert.equal(indexes().length, 3); assert.deepEqual(store.db.prepare('SELECT * FROM current_room_head').all(), before.head); assert.deepEqual(store.db.prepare('SELECT projection FROM rooms').all(), before.projection);
  const restored = new RoomStore(':memory:'); t.after(() => restored.close());
  replayNdjsonInto(exportNdjsonText(store.db), restored);
  assert.deepEqual(restored.db.prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB 'current_messages_thread_*' ORDER BY name").all(), indexes());
  store.room = restored.room = () => { throw Error('Whole-room hydration forbidden'); };
  assert.equal(store.messageThread(key, 'commons', 'root').thread.body, 'Upgrade preserved'); assert.equal(restored.messageThread(key, 'commons', 'root').thread.body, 'Upgrade preserved');
});
