import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Workers HTTP orientation preserves agent identity and excludes conversation', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./agent-orientation.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']
  });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'OrientationTestRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test' } });
  const headers = { Host: 'room.example.test', 'CF-Connecting-IP': '192.0.2.1' };
  const call = (path, extra = {}) => mf.dispatchFetch('https://room.example.test' + path, { headers: { ...headers, ...extra } });
  try {
    const provision = await call('/__test-orientation');
    assert.equal(provision.status, 200);
    const { token } = await provision.json();
    const auth = { Authorization: 'Bearer ' + token };
    const path = '/api/rooms/commons?view=orientation';
    const response = await call(path, auth);
    const packet = await response.json();
    assert.equal(response.status, 200, JSON.stringify(packet));
    assert.equal(packet.snapshotView, 'orientation');
    assert.equal(packet.snapshotVersion, 1);
    assert.equal(packet.viewerId, 'reader');
    assert.equal(packet.viewerAccountId, null);
    assert.equal(packet.roomId, 'commons');
    assert.deepEqual(Object.keys(packet.state).sort(), ['members', 'room', 'workItems']);
    assert.equal(JSON.stringify(packet).includes('Conversation body must not enter orientation.'), false);
    assert.equal((await call(path)).status, 401);
    for (const suffix of ['&view=work', '&messages=recent', '&unknown=1']) {
      assert.equal((await call(path + suffix, auth)).status, 422, suffix);
    }
    for (const header of ['x-project-room-help-context', 'x-project-room-offer-context', 'x-project-room-audit-view']) {
      assert.equal((await call(path, { ...auth, [header]: header.endsWith('audit-view') ? 'activity-v1' : '1' })).status, 422, header);
    }
  } finally { await mf.dispose(); }
});
