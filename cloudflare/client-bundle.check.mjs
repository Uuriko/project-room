import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildClient } from './build-client.mjs';
import { publicAssetPaths, clientBundleEntries, isClientBundlePath } from '../server/public-assets.mjs';

// Tranche-2 item 1 acceptance, measured against the frozen pre-bundle
// baseline at main 927a642029 (lane-5 measurements, re-derived there from
// the tip tree): src/ ships 125 files / 2,227,728 B; the workspace-open JS
// graph is 76 files / 1,624,414 B (~82 requests with HTML and CSS); the door
// first-paint JS static closure (entry.js + signin-entry.js) is 13 files /
// 171,725 B. The door target is a property of the entry bundle's static
// closure: at most 5 requests and at least 60% fewer bytes.
const DOOR_BASELINE_FILES = 13;
const DOOR_BASELINE_BYTES = 171_725;
const WORKSPACE_BASELINE_FILES = 76;
const WORKSPACE_BASELINE_BYTES = 1_624_414;

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// Static edges of an emitted bundle: `from"./chunk-X.js"` (import/re-export)
// and bare `import"./chunk-X.js"` (side-effect import). Dynamic import()
// has a parenthesis before the specifier and is deliberately not an edge:
// it is the on-demand half of the graph, not first paint.
function staticEdges(text) {
  const edges = new Set();
  for (const match of text.matchAll(/from["'](\.\/[^"']+)["']/g)) edges.add(match[1].slice(2));
  for (const match of text.matchAll(/import["'](\.\/[^"']+)["']/g)) edges.add(match[1].slice(2));
  return edges;
}

test('client bundle build: manifest-exact outputs that meet the door target', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'room-client-bundle-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const dist = pathToFileURL(scratch + '/client-dist/');
  // The outputs are .js in a scratch directory: mark it a module tree so
  // `node --check` parses them as the ESM they are.
  await writeFile(join(scratch, 'package.json'), '{"type":"module"}\n');
  const manifest = await buildClient({
    outDirectory: new URL('./src/', dist),
    manifestDirectory: dist,
  });

  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.entries).sort(), [...clientBundleEntries].sort(),
    'the manifest names exactly the registered bundle entries');

  // The pattern must never claim an existing source: hyphenated sources
  // (visibility-coordinator.js, peer-dm-client.js, ...) stay exact-path
  // assets, or pattern serving would shadow real files.
  for (const path of publicAssetPaths)
    assert.ok(!isClientBundlePath(path), `bundle pattern must not match the source asset: ${path}`);

  const texts = new Map();
  let totalBytes = 0;
  for (const file of manifest.files) {
    assert.ok(isClientBundlePath(file.path), `bundle output matches the served bundle pattern: ${file.path}`);
    const bytes = await readFile(new URL(file.path, dist));
    assert.equal(bytes.length, file.bytes, `${file.path} byte length matches the manifest`);
    assert.equal(sha256(bytes), file.sha256, `${file.path} sha256 matches the manifest`);
    totalBytes += bytes.length;
    texts.set(file.path, bytes.toString('utf8'));
    const check = spawnSync(process.execPath, ['--check', join(scratch, 'client-dist', file.path)], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${file.path} parses as a module: ${check.stderr}`);
  }

  // Door first paint: the entry bundle's static closure.
  const entryPath = manifest.entries['src/entry.js'];
  const closure = new Set([entryPath]);
  const queue = [entryPath];
  while (queue.length) {
    const current = queue.pop();
    for (const edge of staticEdges(texts.get(current) ?? '')) {
      const path = 'src/' + edge;
      if (!closure.has(path)) { closure.add(path); queue.push(path); }
    }
  }
  const doorBytes = [...closure].reduce((sum, path) => sum + (manifest.files.find(file => file.path === path)?.bytes ?? 0), 0);
  assert.ok(closure.size <= 5, `door first paint is ${closure.size} requests (baseline ${DOOR_BASELINE_FILES}), target at most 5`);
  assert.ok(doorBytes <= DOOR_BASELINE_BYTES * 0.4,
    `door first paint is ${doorBytes} B (baseline ${DOOR_BASELINE_BYTES} B), target at least 60% fewer`);

  // Workspace open: every bundle output is one request; report the honest
  // figure against the raw graph instead of promising the old <=8 shape,
  // which entry-graph restructuring beyond bundling would be needed to hit.
  assert.ok(manifest.files.length < WORKSPACE_BASELINE_FILES,
    `workspace bundle outputs ${manifest.files.length} vs ${WORKSPACE_BASELINE_FILES} raw files`);
  assert.ok(totalBytes < WORKSPACE_BASELINE_BYTES,
    `workspace bundle bytes ${totalBytes} vs ${WORKSPACE_BASELINE_BYTES} raw bytes`);
  console.log(`client bundle: door ${closure.size} requests / ${doorBytes} B; workspace ${manifest.files.length} outputs / ${totalBytes} B`);

  // Equivalence hazard 1: src/human-push.js registers the service worker
  // with new URL("../push-sw.js", import.meta.url). Bundles are served flat
  // under /src/ — the same depth as the sources — so the emitted code must
  // still carry that exact resolution.
  const pushCarrier = [...texts.values()].find(text => text.includes('push-sw.js'));
  assert.ok(pushCarrier, 'an emitted bundle still names push-sw.js');
  assert.ok(pushCarrier.includes('import.meta.url'), 'the push-sw.js resolution still keys on import.meta.url');
  assert.ok(pushCarrier.includes('../push-sw.js'), 'the push-sw.js reference keeps its ../ depth');

  // Equivalence hazard 2: src/app.js self-starts only when a module script
  // tag names /src/app.js (pre-entry-split cached HTML). No packaged page
  // names the app bundle, so the guard must survive bundling verbatim and
  // stay unmatched in the bundled flow.
  const appText = texts.get(manifest.entries['src/app.js']);
  assert.ok(appText?.includes('/src/app.js'), 'the app bundle retains the literal /src/app.js self-start selector');
});
