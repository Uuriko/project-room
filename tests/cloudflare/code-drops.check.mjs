// Code drops on actual Worker SQLite (Durable Object), not Node SQLite:
// share, duplicate, list, exact raw bytes with sha256, check, delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';

const MBOX = `From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Claude <noreply@anthropic.com>
Subject: [PATCH] Add a greeting

---
diff --git a/hello.txt b/hello.txt
new file mode 100644
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
+hello
--
2.43.0

base-commit: abcdef0123456789abcdef0123456789abcdef01
`;

test('code drops on Worker SQLite: share, raw bytes, check, delete', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin },
    serviceBindings: { ASSETS: async () => new Response(null, { status: 404 }) } });
  try {
    const call = (path, { data, key, method = data ? 'POST' : 'GET' } = {}) => mf.dispatchFetch(origin + path, {
      method, headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.9', Authorization: `Bearer ${key}`,
        ...(data ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const json = async (response, status = 200) => {
      assert.equal(response.status, status, response.status >= 400 ? await response.clone().text() : 'status');
      return response.json();
    };
    const { ownerKey: key } = await json(await call('/__test-provision'));
    const data = Buffer.from(MBOX).toString('base64');
    const sha = createHash('sha256').update(MBOX).digest('hex');
    const { drop } = await json(await call('/api/rooms/commons/code', { key, data: { kind: 'mbox', title: 'Greeting', data } }), 201);
    assert.equal(drop.id, `cd-${sha.slice(0, 12)}`);
    assert.equal(drop.base, 'abcdef0123456789abcdef0123456789abcdef01');
    assert.equal((await json(await call('/api/rooms/commons/code', { key, data: { kind: 'mbox', title: 'Again', data } }))).drop.id, drop.id);
    const list = await json(await call('/api/rooms/commons/code', { key }));
    assert.deepEqual(list.drops.map(d => d.id), [drop.id]);
    const raw = await call(`/api/rooms/commons/code/${drop.id}/raw`, { key });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('x-content-sha256'), sha);
    assert.equal(await raw.text(), MBOX);
    const checked = await json(await call(`/api/rooms/commons/code/${drop.id}/checks`, { key, data: { verdict: 'comment', note: 'on Workers' } }));
    assert.deepEqual(checked.drop.checks.map(c => [c.checkerId, c.verdict]), [['owner', 'comment']]);
    assert.equal((await json(await call(`/api/rooms/commons/code/${drop.id}/checks`, { key, data: { verdict: 'comment', note: 'on Workers' } }))).status, 'unchanged');
    await json(await call('/api/rooms/commons/commands', { key, data: { id: randomUUID(), type: 'message.deleted',
      data: { messageId: drop.messageId, expectedMessageRevision: 0, reason: 'remove' } } }), 201);
    assert.equal((await call(`/api/rooms/commons/code/${drop.id}/raw`, { key })).status, 404);
  } finally { await mf.dispose(); }
});
