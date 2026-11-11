import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { createRoomServer } from '../server/http.mjs';

for (const [label, body] of [['CJK', '界'.repeat(65536)], ['astral', '界' + '🪷'.repeat(32767) + '界']]) {
  test(`hidden accepted ${label} opening does not poison cold unrelated HTTP catch-up`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'event-envelope-http-')), filename = join(directory, 'room.sqlite');
    let store = new RoomStore(filename), server;
    const events = initialRoom();
    for (const id of ['recipient', 'unrelated']) events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
      data: { memberId: id, displayName: id, kind: 'agent', permissions: [] } }));
    store.initialize(events, { representation: 'normalized-current-v1' });
    const keys = Object.fromEntries(['owner', 'recipient', 'unrelated'].map(id => [id, store.issueAccessKey('commons', id)]));
    const open = async () => {
      store.room = () => { throw Error('No whole-room read'); };
      server = createRoomServer({ store });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    };
    const close = async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
    await open();
    t.after(async () => { await close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const call = async (actor, path, data) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(origin + '/api/rooms/commons' + path, {
        method: data ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + keys[actor], Origin: origin,
          ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {})
      });
      return { status: response.status, value: await response.json() };
    };
    assert.equal(body.length, 65536);
    const posted = await call('owner', '/commands', { id: 'large-opening', type: 'message.posted',
      data: { messageId: 'large-private', toMemberId: 'recipient', body } });
    assert.equal(posted.status, 201);
    const openingSequence = posted.value.sequence;
    const later = await call('owner', '/commands', { id: 'later-opening', type: 'message.posted',
      data: { messageId: 'later-visible', toMemberId: 'unrelated', body: 'Later unrelated obligation' } });
    assert.equal(later.status, 201);
    await close(); store.close(); store = new RoomStore(filename); await open();
    const head = store.headSequence('commons');
    const first = await call('unrelated', `/agent-inbox?after=${openingSequence - 1}&limit=4`);
    assert.equal(first.status, 200, JSON.stringify(first.value));
    assert.deepEqual(first.value.directMessages, []);
    assert.equal(first.value.cursor.after, openingSequence);
    assert.equal(first.value.cursor.hasMore, true);
    assert.ok(!JSON.stringify(first.value).includes('large-private'));
    assert.ok(!JSON.stringify(first.value).includes(body.slice(0, 64)));
    const next = first.value.cursor.nextRead.arguments;
    const second = await call('unrelated', `/agent-inbox?after=${next.after}&limit=${next.limit}`);
    assert.equal(second.status, 200, JSON.stringify(second.value));
    assert.deepEqual(second.value.directMessages.map(row => [row.messageId, row.body]), [['later-visible', 'Later unrelated obligation']]);
    assert.equal(second.value.cursor.hasMore, false);
    assert.equal(store.headSequence('commons'), head);
    for (const path of ['/conversation?messageId=large-private', '/messages/large-private/thread']) {
      const denied = await call('unrelated', path);
      assert.equal(denied.status, 404);
      assert.equal(denied.value.error.code, 'message_not_found');
    }
  });
}

for (const [label, body] of [['CJK', '界'.repeat(65536)], ['astral', '界' + '🪷'.repeat(32767) + '界']]) {
  test(`recent inbox continues across an obsolete ${label} opening without loading its old body`, async t => {
    const events = initialRoom(), add = (type, data) => events.push(event({ roomId: 'commons', actorId: 'owner', type, data }));
    add('member.added', { memberId: 'recipient', displayName: 'Recipient', kind: 'agent', permissions: [] });
    add('message.posted', { messageId: 'historical-opening', toMemberId: 'recipient', body });
    // Legitimate replay of a long-lived edited message. The modern reducer's
    // existing 25-entry history cap evicts the old large canonical history;
    // the opening event still retains its accepted full-size original body.
    for (let revision = 0; revision < 26; revision++) add('message.edited', {
      messageId: 'historical-opening', expectedMessageRevision: revision, body: 'Current revision ' + (revision + 1)
    });
    add('message.posted', { messageId: 'newer-opening', toMemberId: 'recipient', body: 'More recent message' });
    const store = new RoomStore(':memory:');
    store.initialize(events, { representation: 'normalized-current-v1' });
    const key = store.issueAccessKey('commons', 'recipient');
    store.room = () => { throw Error('No whole-room read'); };
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const read = async query => {
      const response = await fetch(origin + '/api/rooms/commons/agent-inbox?' + query, { headers: { authorization: 'Bearer ' + key } });
      return { status: response.status, value: await response.json() };
    };
    const before = store.headSequence('commons'), first = await read('limit=4');
    assert.equal(first.status, 200, JSON.stringify(first.value));
    assert.deepEqual(first.value.directMessages.map(row => row.messageId), ['newer-opening']);
    assert.equal(first.value.older.hasMore, true, 'Raw source prefix must not silently skip the historical opening');
    const pointer = first.value.older.nextRead.arguments;
    const second = await read(new URLSearchParams({ limit: pointer.limit, olderCursor: pointer.olderCursor }));
    assert.equal(second.status, 200, JSON.stringify(second.value));
    assert.deepEqual(second.value.directMessages.map(row => [row.messageId, row.body]), [['historical-opening', 'Current revision 26']]);
    assert.equal(second.value.older.hasMore, false);
    assert.equal(store.headSequence('commons'), before);
  });
}
