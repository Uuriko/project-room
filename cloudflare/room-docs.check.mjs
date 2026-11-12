import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Worker room documents: explicit flag, revisions, pagination, room isolation and persisted restart', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./room-docs.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'room-docs-worker-'));
  const config = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'DocsTestRoom', useSQLite: true } }, durableObjectsPersist: persistence, bindings: { ROOM_ORIGIN: 'https://room.example.test', ROOM_DOCS: '1' } };
  let mf = new Miniflare(config);
  const call = async (path, key, body) => {
    const response = await mf.dispatchFetch('https://room.example.test' + path, { method: body ? 'POST' : 'GET', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  try {
    const seed = await call('/__test-docs-seed'); assert.equal(seed.status, 200);
    const { key, otherKey } = seed.value;
    assert.deepEqual((await call('/api/rooms/commons/docs', key)).value.docs, []);
    for (const id of ['a', 'b']) assert.equal((await call('/api/rooms/commons/docs/' + id, key, { title: id, body: 'private ' + id, baseRev: 0 })).status, 201);
    assert.equal((await call('/api/rooms/commons/docs/a', key, { title: 'a2', body: 'second', baseRev: 1 })).status, 200);
    assert.equal((await call('/api/rooms/commons/docs/a', key, { title: 'bad', body: 'bad', baseRev: 1 })).status, 409);
    const first = await call('/api/rooms/commons/docs?limit=1', key); assert.equal(first.value.hasMore, true); assert.equal(first.value.nextAfter, 'a');
    assert.deepEqual((await call('/api/rooms/commons/docs?after=a', key)).value.docs.map(d => d.docId), ['b']);
    assert.equal((await call('/api/rooms/other/docs/a', otherKey)).status, 404);
    await mf.dispose(); mf = new Miniflare(config);
    const historical = await call('/api/rooms/commons/docs/a?rev=1', key); assert.equal(historical.status, 200); assert.equal(historical.value.doc.body, 'private a');
    assert.equal((await call('/api/rooms/commons/docs/a', key)).value.doc.rev, 2);
    await mf.dispose(); mf = new Miniflare({ ...config, bindings: { ROOM_ORIGIN: 'https://room.example.test' } });
    assert.equal((await call('/api/rooms/commons/docs', key)).status, 404);
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
