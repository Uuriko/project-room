import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assetPaths, buildAssets } from '../cloudflare/build-assets.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'room-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return pathToFileURL(directory + '/');
}
test('asset build produces and refreshes exactly the allowlisted application files', async t => {
  const output = await fixture(t);
  assert.equal(await buildAssets(output), assetPaths.length);
  await writeFile(new URL('src/app.js', output), 'stale generated asset');
  await buildAssets(output);
  assert.deepEqual((await readdir(output)).sort(), ['index.html', 'src']);
  assert.deepEqual((await readdir(new URL('src/', output))).sort(), assetPaths.filter(p => p.startsWith('src/')).map(p => p.slice(4)).sort());
  for (const file of assetPaths) assert.deepEqual(await readFile(new URL(file, output)), await readFile(new URL('../' + file, import.meta.url)));
  const config = JSON.parse(await readFile(new URL('../cloudflare/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.build.command, 'node build-assets.mjs', 'deploy always builds this exact source');
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
