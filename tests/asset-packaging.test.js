import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assetPaths, buildAssets } from '../cloudflare/build-assets.mjs';
import { templateAssetPaths, generatedAgentPages } from '../server/public-assets.mjs';

// Decision #36 (#3254, Option A): the generated agent pages are build output
// and never committed, so a plain checkout (and every exact-commit package)
// legitimately lacks them; the deploy build generates them first (the
// wrangler command asserted in the first test). The packaged/served contract
// below is therefore stated against the allowlist minus the generated pages
// absent from this tree — everything else must always be present.
const absentGenerated = file => generatedAgentPages.includes(file) && !existsSync(new URL('../' + file, import.meta.url));
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'room-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return pathToFileURL(directory + '/');
}
test('asset build produces and refreshes exactly the allowlisted application files', async t => {
  const output = await fixture(t);
  const packaged = [...assetPaths, ...templateAssetPaths];
  const produced = packaged.filter(file => !absentGenerated(file));
  assert.equal(await buildAssets(output), produced.length);
  await writeFile(new URL('src/app.js', output), 'stale generated asset');
  await buildAssets(output);
  // Derived from the allowlist rather than written down: 'connectors' was
  // added to publicAssets and this line still said ['index.html', 'src'].
  const topLevel = [...new Set(produced.map(path => path.includes('/') ? path.slice(0, path.indexOf('/')) : path))].sort();
  assert.deepEqual((await readdir(output)).sort(), topLevel);
  assert.deepEqual((await readdir(new URL('src/', output))).sort(), produced.filter(p => p.startsWith('src/')).map(p => p.slice(4)).sort());
  for (const file of produced) assert.deepEqual(await readFile(new URL(file, output)), await readFile(new URL('../' + file, import.meta.url)));
  const config = JSON.parse(await readFile(new URL('../cloudflare/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.build.command, 'node ../scripts/build-agent-docs.mjs && node ../scripts/build-faq.mjs && node ../scripts/stamp-version.mjs && node ../scripts/build-capabilities.mjs && node ../scripts/sign-agent-card.mjs && node build-assets.mjs', 'deploy builds the generated agent pages and the FAQ page first, then stamps the committed revision before building exact assets');
});
test('the deployment allowlist and the runtime package agree on the public assets', async () => {
  // Three lists name the browser assets: cloudflare/build-assets.mjs (what is
  // uploaded), server/http.mjs (what is served) and scripts/runtime-package.mjs
  // (what an exact-commit package contains). The first two are checked by the
  // tests either side of this one. The third was not, and
  // src/handoff-envelope-ui.js landed in two of the three - which did not show
  // up as a missing file but as `createRuntimePackage` refusing to build at
  // all, failing seven tests across five files with an error about an import
  // closure. This states the invariant in one line so the next one says so.
  const { publicAssets, generatedAgentPages: packagedGenerated } = await import('../scripts/runtime-package.mjs');
  assert.deepEqual([...publicAssets].sort(), [...assetPaths].sort());
  // The standalone package verifier keeps its own copy of the generated-page
  // set (it parses declarations as text and cannot import this module); the
  // two copies must name exactly the same pages or the package filter and
  // the server/build behavior drift apart silently.
  assert.deepEqual([...packagedGenerated].sort(), [...generatedAgentPages].sort());
});

test('every local browser import is included in the deployment allowlist', async () => {
  for (const file of assetPaths.filter(path => path.endsWith('.js'))) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const dependency = posix.normalize(posix.join(posix.dirname(file), match[1]));
      assert.ok(assetPaths.includes(dependency), `${file} imports an unpackaged asset: ${dependency}`);
    }
  }
});
test('the HTTP allowlist serves every packaged browser asset with exact bytes', async t => {
  const store = new RoomStore(':memory:'), server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of assetPaths.filter(file => !absentGenerated(file))) {
    const response = await fetch(origin + '/' + path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../' + path, import.meta.url)), path);
  }
  // Absent generated pages are the designed package state (decision #36):
  // the server answers 404 for them, never a 500.
  for (const path of assetPaths.filter(absentGenerated)) {
    const response = await fetch(origin + '/' + path);
    assert.equal(response.status, 404, path);
  }
});
test('asset build rejects unknown files without uploading or deleting them', async t => {
  const output = await fixture(t);
  await mkdir(new URL('.operator/', output));
  await writeFile(new URL('.operator/example.txt', output), 'synthetic private file');
  await assert.rejects(buildAssets(output), /Unexpected asset output/);
  assert.equal(await readFile(new URL('.operator/example.txt', output), 'utf8'), 'synthetic private file');
});
test('asset build rejects symbolic-link destinations without following them', async t => {
  const output = await fixture(t), target = new URL('outside.txt', await fixture(t));
  await writeFile(target, 'unchanged');
  await symlink(fileURLToPath(target), new URL('index.html', output));
  await assert.rejects(buildAssets(output), /Unexpected asset output/);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
test('hosted check help and invalid flags stop before browser or credential access', () => {
  const script = fileURLToPath(new URL('../cloudflare/hosted-check.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /synthetic guest/);
  assert.equal(help.stderr, '');
  const invalid = spawnSync(process.execPath, [script, '--not-a-mode'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown option/);
});
test('asset build rejects a directory symlink even when its URL has a trailing slash', async t => {
  const parent = await fixture(t), target = await fixture(t), output = new URL('output/', parent);
  await symlink(fileURLToPath(target), new URL('output', parent), 'dir');
  await assert.rejects(buildAssets(output), /real directory/);
  assert.deepEqual(await readdir(target), [], 'the linked directory remains untouched');
});
