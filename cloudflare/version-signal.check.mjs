import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Storage/DO-independent version signal: GET /api/version/worker is answered
// entirely by the Worker from module scope + env - no Durable Object round
// trip - so deploy verification survives a DO outage. The durable-object id
// is derived (idFromName), identifying the object this Worker would route
// to; two doors serving different ids are a split. It claims nothing about
// room health.
test('pure-Worker /api/version/worker: revision, build, deployment, served object id', async () => {
  const cloudflareDir = fileURLToPath(new URL('.', import.meta.url));
  const bundled = await build({
    stdin: { contents: `export { default, ProjectRoom } from './room.mjs';`, resolveDir: cloudflareDir, loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']
  });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin, ROOM_DEPLOYMENT: 'staging' }
  });
  try {
    const call = (url, { method = 'GET', host } = {}) => mf.dispatchFetch(url, { method, headers: { Host: host ?? new URL(url).host } });

    const res = await call(origin + '/api/version/worker');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.servedBy, 'worker');
    assert.equal(body.sourceRevision, 'unstamped');
    assert.equal(body.buildId, 'unstamped');
    assert.equal(body.deployment, 'staging');
    assert.deepEqual(Object.keys(body.durableObject).sort(), ['id', 'name']);
    assert.equal(body.durableObject.name, 'invite-only-pilot');
    assert.match(body.durableObject.id, /^[0-9a-f]{64}$/);

    // The derived object id is stable for the same namespace + name, which is
    // exactly what makes a door-split comparable across doors.
    const again = await (await call(origin + '/api/version/worker')).json();
    assert.equal(again.durableObject.id, body.durableObject.id);

    // Trailing slash answers identically.
    assert.equal((await call(origin + '/api/version/worker/')).status, 200);

    // HEAD carries the headers and no body.
    const head = await call(origin + '/api/version/worker', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    // Edge doors rewrite /room/api/* onto the Room origin before the host
    // guard, so the signal answers on them too.
    const door = await call('https://www.getdasha.com/room/api/version/worker');
    assert.equal(door.status, 200);
    assert.equal((await door.json()).durableObject.id, body.durableObject.id);

    // A spoofed host is still refused by the origin guard.
    assert.equal((await call('https://spoofed.example/api/version/worker')).status, 403);
  } finally {
    await mf.dispose();
  }
});
