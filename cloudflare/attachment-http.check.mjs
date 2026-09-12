import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('real Worker HTTP bridge preserves bounded file bytes and safe downloads', { timeout: 60000 }, async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin } });
  const call = (path, options = {}) => mf.dispatchFetch(origin + path, { ...options,
    headers: { Host: 'room.example.test', 'CF-Connecting-IP': '192.0.2.1', ...options.headers } });
  try {
    const { ownerKey } = await (await call('/__test-provision')).json();
    const headers = { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'image/svg+xml', 'X-File-Name': 'diagram.svg' };
    const path = '/api/rooms/commons/attachments/worker-file';
    const bytes = new Uint8Array(1048576); bytes[0] = 255; bytes[bytes.length - 1] = 23;
    const upload = await call(path, { method: 'PUT', headers, body: bytes });
    assert.equal(upload.status, 200, await upload.clone().text());
    assert.equal((await upload.json()).byteLength, bytes.length);
    const status = await call(path + '/status', { headers });
    assert.equal(status.status, 200);
    const staged = await status.json();
    assert.equal(staged.state, 'staged'); assert.equal(staged.byteLength, bytes.length);
    assert.equal(Object.hasOwn(staged, 'bytes'), false);
    assert.equal((await call(path, { headers })).status, 404);
    const post = await call('/api/rooms/commons/commands', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'worker-file-post', type: 'message.posted', data: { messageId: 'worker-message', body: '', attachmentIds: ['worker-file'] } }) });
    assert.equal(post.status, 201, await post.clone().text());
    const committed = await (await call(path + '/status', { headers })).json();
    assert.equal(committed.state, 'committed'); assert.equal(committed.messageId, 'worker-message');
    const result = await call(path, { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
    assert.equal(result.headers.get('content-type'), 'application/octet-stream');
    assert.match(result.headers.get('content-disposition'), /^attachment;/);
    const head = await call(path, { method: 'HEAD', headers });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await call(path + '-large', { method: 'PUT', headers, body: new Uint8Array(1048577) })).status, 413);
    assert.equal((await call(path)).status, 401);
  } finally { await mf.dispose(); }
});
