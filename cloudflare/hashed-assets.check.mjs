import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareHostedAssets, requireHashedBundler } from './build-assets.mjs';
import { edgePublicResponse, hashedAssetFile } from './edge-public.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'room-hashed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return pathToFileURL(directory + '/');
}

test('hosted build hashes entries, keeps relative chunks, and serves them immutable', async t => {
  const output = await fixture(t);
  await mkdir(new URL('a/', output), { recursive: true });
  await writeFile(new URL('a/stale-aaaaaaaa.js', output), 'stale');
  await writeFile(new URL('a/generation.json', output), JSON.stringify(['stale-aaaaaaaa.js', 'missing-bbbbbbbb.js']));
  await writeFile(new URL('a/older-cccccccc.js', output), 'older');
  const { hashed } = await prepareHostedAssets(output);
  assert.equal(await readFile(new URL('a/stale-aaaaaaaa.js', output), 'utf8'), 'stale', 'the previous generation stays servable for one rollback');
  assert.equal(await readFile(new URL('a/older-cccccccc.js', output), 'utf8').catch(error => error.code), 'ENOENT', 'a hash already older than the previous generation is not kept');
  const kept = JSON.parse(await readFile(new URL('a/generation.json', output), 'utf8'));
  assert.equal(kept.includes('stale-aaaaaaaa.js'), false);
  assert.equal(kept.includes(hashed.map['src/entry.js'].slice(2)), true);
  const index = await readFile(new URL('index.html', output), 'utf8');
  assert.match(index, /src="\.\/a\/entry-[A-Za-z0-9._-]{8,}\.js"/);
  assert.match(index, /href="\.\/a\/styles-[a-f0-9]{10}\.css"/);
  assert.doesNotMatch(index, /src\/entry\.js|src\/styles\.css/);
  const join = await readFile(new URL('join.html', output), 'utf8');
  assert.match(join, /src="\{\{ASSET_BASE\}\}\/a\/join-[A-Za-z0-9._-]{8,}\.js"/);
  assert.match(join, /src="\{\{ASSET_BASE\}\}\/a\/join-watchdog-[A-Za-z0-9._-]{8,}\.js"/);
  assert.match(join, /\{\{ASSET_BASE\}\}\//);
  const about = await readFile(new URL('about.html', output), 'utf8');
  assert.match(about, /src="\/src\/front-door\.js"/);
  const frontDoor = await readFile(new URL('src/front-door.js', output), 'utf8');
  assert.match(frontDoor, /\/api\/public\/front-door/);
  const app = await readFile(new URL('src/app.js', output));
  assert.deepEqual(app, await readFile(new URL('../src/app.js', import.meta.url)));
  const entry = hashed.map['src/entry.js'];
  const entryText = await readFile(new URL(entry, output), 'utf8');
  assert.doesNotMatch(entryText, /(?:from|import\()\s*["']\//);
  const styles = await readFile(new URL(hashed.map['src/styles.css'], output), 'utf8');
  assert.match(styles, /\/og\/fonts\/Inter-Regular\.woff2/);

  const file = hashedAssetFile('/' + entry);
  assert.equal(file, entry);
  let fetches = 0;
  const counting = {
    ROOM_ORIGIN: 'https://room.example.test',
    ASSETS: {
      fetch: async request => {
        fetches += 1;
        const path = new URL(request.url).pathname.slice(1);
        try { return new Response(await readFile(new URL(path, output))); }
        catch (error) { if (error.code === 'ENOENT') return new Response('missing', { status: 404 }); throw error; }
      }
    }
  };
  const url = new URL('https://room.example.test/' + entry);
  const response = await edgePublicResponse(new Request(url), counting, url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await response.text(), entryText);
  assert.equal(fetches, 1);
  const door = new URL('https://room.example.test/room/' + entry);
  const prefixed = await edgePublicResponse(new Request(door), counting, door);
  assert.equal(prefixed.status, 200);
  assert.equal(prefixed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(fetches, 1, 'the /room prefix reads the same isolate cache entry');
  const missing = new URL('https://room.example.test/a/missing-file.js');
  const absent = await edgePublicResponse(new Request(missing), counting, missing);
  assert.equal(absent.status, 404);
  assert.equal(fetches, 2);

  await prepareHostedAssets(output);
  assert.equal(await readFile(new URL('a/stale-aaaaaaaa.js', output), 'utf8').catch(error => error.code), 'ENOENT', 'only the immediately previous generation is kept');
  assert.equal(await readFile(new URL(entry, output), 'utf8').then(text => text.length > 0).catch(() => false), true, 'the generation this build replaced is still on disk');
});

test('a missing hashed-asset bundler fails the build', () => {
  assert.throws(() => requireHashedBundler(new URL('./missing-bundler.mjs', import.meta.url)), /Refusing to deploy unbundled assets/);
});
