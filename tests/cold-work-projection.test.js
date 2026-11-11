import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { selectedMessageRecord } from '../server/message-repository.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

for (const mode of ['inline', 'body-ref', 'entity']) for (const count of [10, 100]) {
  const bodiesAtRest = mode === 'body-ref';
  const options = { bodiesAtRest, ...(mode === 'entity' ? { messageProjectionWindow: 200, messageEntityProjection: true } : {}) };
  test(`cold work HTTP reads avoid unrelated ${count} message bodies (storage ${mode})`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'cold-work-'));
    const path = join(dir, 'room.sqlite');
    let now = Date.now();
    let store = new RoomStore(path, { ...options, now: () => now });
    store.initialize(initialRoom());
    const token = store.issueAccessKey('commons', 'owner');
    for (let i = 0; i < count; i++) {
      now += 2000;
      store.command(token, 'commons', { id: `seed-${i}`, type: 'message.posted', data: { messageId: `m-${i}`, body: (i === 0 ? 'selected-source ' : `unrelated-${i} `) + 'x'.repeat(2000) } });
    }
    store.command(token, 'commons', { id: 'propose', type: 'work.proposed', data: { workItemId: 'one', title: 'Selected work', definitionOfDone: 'Keep the actual work record', mode: 'read', accountableMemberId: 'owner', sourceMessageId: 'm-0' } });
    if (mode === 'entity') {
      while (!store.backfillMessages({ limit: 1000 }).done) { /* certify entities */ }
      assert.equal(store.checkMessagesParity().ok, true);
      store.command(token, 'commons', { id: 'qualified-post', type: 'message.posted', data: { messageId: 'qualified', body: 'Latest note' } });
    }
    if (mode === 'entity') assert.ok(JSON.parse(store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection).messages.some(m => m._entity === 1));
    const expected = store.snapshot(token, 'commons', null, 'work');
    delete expected.state.agentHalts;
    store.close();
    store = new RoomStore(path, { ...options, now: () => now });
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
    const originalRoom = store.room.bind(store);
    const guard = t.mock.method(store, 'room', () => { throw new Error('work read hydrated full conversation'); });
    const url = `http://127.0.0.1:${server.address().port}/api/rooms/commons?view=work`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const context = await new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token }).workContext('one', { includeSource: true });
      assert.equal(context.work.id, 'one');
      assert.equal(context.context.source.message.body, 'selected-source ' + 'x'.repeat(2000));
      assert.equal(JSON.stringify(context).includes('unrelated-'), false);
      const board = await new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', token }).board();
      assert.equal(board.counts.total, 1);
      assert.equal(board.columns.proposed[0].id, 'one');
      assert.equal(JSON.stringify(board).includes('unrelated-'), false);
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      assert.deepEqual(value, expected);
      assert.equal(JSON.stringify(value).includes('unrelated-'), false);
    }
    assert.equal(guard.mock.callCount(), 0);
    // A work-only result must not poison the full projection cache.
    guard.mock.restore();
    assert.ok(originalRoom('commons').state.messages.some(m => m.id === `m-${count - 1}`));
    if (mode === 'body-ref') {
      const sha = JSON.parse(store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection).messages.find(m => m.id === 'm-0').bodyRef;
      store.db.prepare('UPDATE projection_bodies SET body=? WHERE room_id=? AND sha=?').run('tampered', 'commons', sha);
      assert.equal(store.workContext(token, 'commons', 'one', { includeSource: true }).context.source.message.body, 'selected-source ' + 'x'.repeat(2000));
    }
    if (mode === 'entity') {
      store.db.prepare('UPDATE messages SET reducer_extras_json=? WHERE room_id=? AND message_id=?').run('invalid', 'commons', 'm-0');
      assert.throws(() => store.workContext(token, 'commons', 'one', { includeSource: true }), /projection_corrupt/);
    }
    store.db.prepare("UPDATE work_entities SET body='{}' WHERE room_id=? AND work_id=?").run('commons', 'one');
    assert.throws(() => store.snapshot(token, 'commons', null, 'work'), /work_projection_corrupt/);
    store.revoke(token);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    t.diagnostic(`history=${count}; full hydration calls=0; response=${Buffer.byteLength(JSON.stringify(expected))} bytes`);
  });
}

test('selected canonical lookup preserves archived records without trusting uncertified live rows', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  for (let i = 0; i < 5; i++) store.command(token, 'commons', { id: `archive-seed-${i}`, type: 'message.posted', data: { messageId: `archive-m-${i}`, body: `archive body ${i}` } });
  for (let i = 0; i < 20; i++) if (store.backfillMessages({ limit: 1000 }).done) break;
  assert.equal(store.checkMessagesParity().ok, true);
  assert.equal(store.archiveMessages('commons', { keepNewest: 1, dryRun: false }).ok, true);
  const expected = selectedMessageRecord(store, 'commons', 'archive-m-0', true);
  assert.equal(expected.body, 'archive body 0');
  t.mock.method(store, 'room', () => { throw new Error('full hydration'); });
  assert.deepEqual(selectedMessageRecord(store, 'commons', 'archive-m-0', true), expected);
  assert.equal(selectedMessageRecord(store, 'commons', 'archive-m-0', false), undefined);
  assert.equal(selectedMessageRecord(store, 'commons', 'missing', true), undefined);
});
