import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Worker routing and SQLite serve the bounded agent work observation', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin } });
  const call = (path, token) => mf.dispatchFetch(origin + path, {
    headers: { Host: 'room.example.test', 'CF-Connecting-IP': '192.0.2.1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  try {
    const provision = await call('/__test-provision'); assert.equal(provision.status, 200);
    const { ownerKey } = await provision.json();
    assert.equal((await call('/api/rooms/commons/agent-work')).status, 401);
    const response = await call('/api/rooms/commons/agent-work', ownerKey);
    assert.equal(response.status, 200, await response.clone().text());
    const raw = await response.text(), value = JSON.parse(raw);
    assert.equal(value.contractVersion, 1); assert.equal(value.roomId, 'commons');
    assert.equal(value.viewerId, 'owner'); assert.equal(value.member.id, 'owner');
    assert.equal(value.executionGranted, false);
    assert.deepEqual(value.requests, []); assert.deepEqual(value.runs, {});
    assert.ok(Buffer.byteLength(raw) < 4096); assert.equal(raw.includes(ownerKey), false);
  } finally { await mf.dispose(); }
});
