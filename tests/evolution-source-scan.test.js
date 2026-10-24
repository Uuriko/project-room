import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvolution, digest } from '../client/evolution/store.mjs';
import { command } from '../scripts/room-evolution.mjs';
import { installPackage, activate } from '../client/evolution/registry.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'source-scan-')), root = join(directory, 'selected'); mkdirSync(root);
  const store = openEvolution(join(directory, 'state'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const options = { sourceId: 'docs', room: 'room', capability: 'process', extensions: ['.txt'] };
  return { store, root, directory, options, async setup() {
    await command(store, 'configure', { rooms: ['room'], capabilities: ['process'], maxJobs: 1, cpuSlots: 2,
      memoryBytes: 1024 ** 3, reserveMemoryBytes: 0, paused: false });
    await command(store, 'source-register', { id: 'docs', root, rooms: ['room'], capabilities: ['process'] });
  }, scan(extra = {}) { return command(store, 'source-scan', { ...options, ...extra }); } };
}
test('source scan produces stable pinned job inputs, omits hidden/dependency/symlink entries and narrows to a subfolder', async t => {
  const f = fixture(t); await f.setup();
  for (const dir of ['nested', '.hidden', 'node_modules']) { mkdirSync(join(f.root, dir)); writeFileSync(join(f.root, dir, 'a.txt'), dir); }
  writeFileSync(join(f.root, 'z.TXT'), 'z'); writeFileSync(join(f.root, 'skip.pdf'), 'not selected');
  symlinkSync(join(f.root, 'nested'), join(f.root, 'link'));
  const scan = await f.scan(), again = await f.scan();
  assert.deepEqual(scan.dataInputs.map(i => i.path), ['nested/a.txt', 'z.TXT']);
  assert.equal(scan.manifestDigest, again.manifestDigest);
  assert.equal(scan.totalBytes, 7); assert.equal(scan.skipped, 4);
  assert.equal(scan.dataInputs[0].sha256, digest('nested'));
  assert.equal(JSON.stringify(scan).includes(f.root), false);
  assert.equal((await f.scan({ path: 'nested' })).dataInputs.length, 1);
  await assert.rejects(f.scan({ path: 'link' }), /data_symlink/);
  await assert.rejects(f.scan({ path: '../outside' }), /invalid_source_scan/);
});
test('scan fails explicitly at bounds and obeys current source grants', async t => {
  const f = fixture(t); await f.setup();
  writeFileSync(join(f.root, 'one.txt'), 'one'); writeFileSync(join(f.root, 'two.txt'), 'two');
  await assert.rejects(f.scan({ maxFiles: 1 }), /data_scan_file_limit/);
  await assert.rejects(f.scan({ room: 'other' }), /data_source_not_authorized/);
  await assert.rejects(f.scan({ extensions: [] }), /invalid_source_scan/);
  await command(f.store, 'source-remove', { id: 'docs' });
  await assert.rejects(f.scan(), /data_source_not_authorized/);
});
test('scanned inputs run without manually constructing filenames and stale content stops execution', async t => {
  const f = fixture(t); await f.setup(); writeFileSync(join(f.root, 'evidence.txt'), 'evidence');
  const source = `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const data=JSON.parse(readFileSync(process.env.ROOM_TASK_DATA));
writeFileSync(join(process.env.ROOM_TASK_OUTPUT,'result.txt'),data.entries.map(e=>readFileSync(e.path,'utf8')).join('|'));`;
  writeFileSync(join(f.directory, 'run.mjs'), source);
  const pack = installPackage(f.store, f.directory, { schema: 1, capability: 'process', version: 'v1', runtime: process.version,
    resources: { cpu: 1, memoryBytes: 64 * 1024 ** 2 }, files: [{ path: 'run.mjs', sha256: digest(source) }],
    steps: [{ id: 'run', module: 'run.mjs', args: [], timeoutMs: 3000 }] });
  activate(f.store, { capability: 'process', hash: pack.hash, expectedRevision: 0, bootstrap: true, reason: 'fixture' });
  const { dataInputs } = await f.scan();
  const { runJob } = await import('../client/evolution/executor.mjs');
  const run = job => runJob(f.store, job.id, { observation: { at: Date.now(), cpuSlots: 8, memoryBytes: 4 * 1024 ** 3 } });
  const job = await command(f.store, 'submit', { room: 'room', operation: 'first', capability: 'process', input: {}, dataInputs });
  const result = await run(job); assert.equal(result.job.state, 'completed');
  assert.equal(readFileSync(join(result.job.result.artifactDirectory, 'result.txt'), 'utf8'), 'evidence');
  writeFileSync(join(f.root, 'evidence.txt'), 'new evidence');
  const stale = await command(f.store, 'submit', { room: 'room', operation: 'stale', capability: 'process', input: {}, dataInputs });
  const failed = await run(stale); assert.equal(failed.job.result.error, 'data_hash_mismatch');
  assert.equal(failed.job.result.steps.length, 0);
});
