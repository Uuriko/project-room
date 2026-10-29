import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

for (const bodiesAtRest of [false, true]) for (const count of [10, 100]) {
  test(`cold work HTTP reads avoid unrelated ${count} message bodies (at-rest ${bodiesAtRest})`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'cold-work-'));
    const path = join(dir, 'room.sqlite');
    let now = Date.now();
    let store = new RoomStore(path, { bodiesAtRest, now: () => now });
    store.initialize(initialRoom());
    const token = store.issueAccessKey('commons', 'owner');
    for (let i = 0; i < count; i++) {
      now += 2000;
      store.command(token, 'commons', { id: `seed-${i}`, type: 'message.posted', data: { messageId: `m-${i}`, body: `unrelated-${i} ` + 'x'.repeat(2000) } });
    }
    store.command(token, 'commons', { id: 'propose', type: 'work.proposed', data: { workItemId: 'one', title: 'Selected work', definitionOfDone: 'Keep the actual work record', mode: 'read', accountableMemberId: 'owner' } });
    const expected = store.snapshot(token, 'commons', null, 'work');
    delete expected.state.agentHalts;
    store.close();
    store = new RoomStore(path, { bodiesAtRest, now: () => now });
    const server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
    const originalRoom = store.room.bind(store);
    const guard = t.mock.method(store, 'room', () => { throw new Error('work read hydrated full conversation'); });
    const url = `http://127.0.0.1:${server.address().port}/api/rooms/commons?view=work`;
    for (let attempt = 0; attempt < 2; attempt++) {
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
    store.db.prepare("UPDATE work_entities SET body='{}' WHERE room_id=? AND work_id=?").run('commons', 'one');
    assert.throws(() => store.snapshot(token, 'commons', null, 'work'), /work_projection_corrupt/);
    store.revoke(token);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    t.diagnostic(`history=${count}; full hydration calls=0; response=${Buffer.byteLength(JSON.stringify(expected))} bytes`);
  });
}
