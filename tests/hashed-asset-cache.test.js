import test from 'node:test';
import assert from 'node:assert/strict';
import { assetCachePolicy, classifyEdgePath, edgePublicResponse, hashedAssetFile } from '../cloudflare/edge-public.mjs';

test('content-hashed bundles are immutable and stay off the Durable Object path', async () => {
  const path = '/a/entry-abc12345.js';
  assert.equal(hashedAssetFile(path), 'a/entry-abc12345.js');
  assert.equal(hashedAssetFile('/room/a/styles-0123abcd.css'), 'a/styles-0123abcd.css');
  assert.equal(hashedAssetFile('/a/../secret.js'), null);
  assert.equal(hashedAssetFile('/src/app.js'), null);
  assert.equal(classifyEdgePath(path), 'asset');
  assert.equal(classifyEdgePath('/room/a/c-abc12345.js'), 'asset');
  assert.equal(assetCachePolicy('text/javascript', path), 'public, max-age=31536000, immutable');
  assert.equal(assetCachePolicy('text/javascript', '/src/app.js'), 'no-cache');

  let fetches = 0;
  const env = {
    ROOM_ORIGIN: 'https://room.example.test',
    ASSETS: { fetch: async () => { fetches += 1; return new Response('bundle'); } }
  };
  const url = new URL('https://room.example.test' + path);
  const first = await edgePublicResponse(new Request(url), env, url);
  const second = await edgePublicResponse(new Request(url), env, url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(first.headers.get('content-type'), /javascript/);
  assert.equal(await first.text(), 'bundle');
  assert.equal(await second.text(), 'bundle');
  assert.equal(fetches, 1);
  const head = await edgePublicResponse(new Request(url, { method: 'HEAD' }), env, url);
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get('content-length'), '6');
  const refused = await edgePublicResponse(new Request(url, { method: 'POST' }), env, url);
  assert.equal(refused.status, 405);
  assert.equal(fetches, 1);
});
