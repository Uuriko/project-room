import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvolution, digest } from '../client/evolution/store.mjs';
import { registerDataSource, removeDataSource, listDataSources, validateDataInputs } from '../client/evolution/data-inputs.mjs';
import { installPackage, activate } from '../client/evolution/registry.mjs';
import { configure, submit, runJob, policy } from '../client/evolution/executor.mjs';
import { runRoomCapability, prefix } from '../client/evolution/room-bridge.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

const memory = 64 * 1024 ** 2;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'data-inputs-')), store = openEvolution(join(directory, 'state'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const root = join(directory, 'selected'); mkdirSync(root); writeFileSync(join(root, 'input.txt'), 'approved source');
  const source = `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const data=JSON.parse(readFileSync(process.env.ROOM_TASK_DATA));
writeFileSync(join(process.env.ROOM_TASK_OUTPUT,'result.txt'),data.entries.map(e=>readFileSync(e.path,'utf8')).join('|'));`;
  writeFileSync(join(directory, 'process.mjs'), source);
  configure(store, { rooms: ['commons'], capabilities: ['process-data'], maxJobs: 1, cpuSlots: 2, memoryBytes: memory * 4, reserveMemoryBytes: 0, paused: false });
  const pack = installPackage(store, directory, { schema: 1, capability: 'process-data', version: 'v1', runtime: process.version,
    resources: { cpu: 1, memoryBytes: memory }, files: [{ path: 'process.mjs', sha256: digest(source) }],
    steps: [{ id: 'process', module: 'process.mjs', args: [], timeoutMs: 3000 }] });
  activate(store, { capability: 'process-data', hash: pack.hash, expectedRevision: 0, bootstrap: true, reason: 'fixture' });
  const grant = extra => registerDataSource(store, { id: 'documents', root, rooms: ['commons'], capabilities: ['process-data'], ...extra }); grant();
  const dataInputs = [{ name: 'document.txt', kind: 'folder', sourceId: 'documents', path: 'input.txt' }];
  const job = (operation, inputs = dataInputs, extra = {}) => submit(store, { room: 'commons', operation, capability: 'process-data', input: {}, dataInputs: inputs, ...extra });
  const observation = () => ({ at: Date.now(), cpuSlots: 8, memoryBytes: memory * 20 });
  const run = (id, extra = {}) => runJob(store, id, { observation: observation(), ...extra });
  return { store, directory, root, grant, dataInputs, job, run, observation };
}
test('selected folder inputs are materialized automatically, provenance pinned, and replay does no work', async t => {
  const f = fixture(t), job = f.job('first'), result = await f.run(job.id);
  assert.equal(result.job.state, 'completed');
  assert.equal(readFileSync(join(result.job.result.artifactDirectory, 'result.txt'), 'utf8'), 'approved source');
  assert.equal(result.job.result.dataInputs[0].sha256, digest('approved source'));
  assert.deepEqual(listDataSources(f.store), [{ id: 'documents', kind: 'folder', rooms: ['commons'], capabilities: ['process-data'], remoteEnabled: false }]);
  writeFileSync(join(f.root, 'input.txt'), 'changed source');
  assert.equal((await f.run(job.id)).claimed, false);
  assert.equal(readFileSync(join(result.job.result.artifactDirectory, 'result.txt'), 'utf8'), 'approved source');
  const next = await f.run(f.job('second').id); assert.equal(next.job.result.dataInputs[0].sha256, digest('changed source'));
});
test('cache reuse never bypasses removed grants or a requested exact content hash', async t => {
  const f = fixture(t); await f.run(f.job('one').id);
  const result = await f.run(f.job('two').id), manifest = JSON.parse(readFileSync(join(f.store.directory, 'runs', result.job.id, '1', 'data.json')));
  assert.equal(manifest.entries[0].cacheReused, true);
  const pinned = f.job('pin', [{ ...f.dataInputs[0], sha256: digest('approved source') }]);
  writeFileSync(join(f.root, 'input.txt'), 'different');
  assert.equal((await f.run(pinned.id)).job.result.error, 'data_hash_mismatch');
  removeDataSource(f.store, 'documents');
  assert.equal((await f.run(f.job('revoked').id)).job.result.error, 'data_source_not_authorized');
});
test('remote jobs cannot use local-only folder grants and local scheduler cannot bypass Room dispatch', async t => {
  const f = fixture(t), job = f.job('remote', f.dataInputs, { dispatch: 'room' });
  assert.equal((await f.run(job.id)).reason, 'job_dispatch_mismatch');
  const result = await f.run(job.id, { dispatch: 'room', dataContext: { requesterId: 'stranger' } });
  assert.equal(result.job.result.error, 'data_source_not_authorized');
  assert.equal(result.job.result.steps.length, 0);
});
test('path escape, duplicate destination names, symlink inputs and changed replay declarations fail', async t => {
  const f = fixture(t);
  assert.throws(() => validateDataInputs([{ ...f.dataInputs[0], path: '../outside' }]), /invalid_data_input/);
  assert.throws(() => validateDataInputs([f.dataInputs[0], f.dataInputs[0]]), /input_name/);
  f.job('same'); assert.throws(() => f.job('same', []), /payload_changed/);
  symlinkSync(join(f.root, 'input.txt'), join(f.root, 'link.txt'));
  const job = f.job('symlink', [{ ...f.dataInputs[0], path: 'link.txt' }]);
  assert.equal((await f.run(job.id)).job.result.error, 'data_symlink');
});
test('byte budgets stop work before recipe execution and cache eviction preserves run copies', async t => {
  const f = fixture(t);
  configure(f.store, { ...policy(f.store), dataLimits: { maxFileBytes: 4, maxTotalBytes: 4, maxCacheBytes: 4 } });
  assert.equal((await f.run(f.job('large').id)).job.result.error, 'data_file_limit');
  writeFileSync(join(f.root, 'input.txt'), 'one'); const one = await f.run(f.job('one').id);
  writeFileSync(join(f.root, 'input.txt'), 'two'); await f.run(f.job('two').id);
  assert.deepEqual(readdirSync(join(f.store.directory, 'data-cache')), [digest('two')]);
  assert.equal(readFileSync(join(f.store.directory, 'runs', one.job.id, '1', 'data', 'document.txt'), 'utf8'), 'one');
});
test('cache corruption is detected before supplying bytes to another job', async t => {
  const f = fixture(t); await f.run(f.job('one').id);
  const path = join(f.store.directory, 'data-cache', digest('approved source')); chmodSync(path, 0o600); writeFileSync(path, 'wrong');
  assert.equal((await f.run(f.job('two').id)).job.result.error, 'data_cache_corrupt');
});
test('real Room request fetches its attachment automatically and rejects another message attachment', async t => {
  const f = fixture(t), room = createAcceptanceFixture(), server = createRoomServer({ store: room.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); room.store.close(); rmSync(room.directory, { recursive: true, force: true }); });
  for (const [from, to] of [['owner', 'producer'], ['producer', 'owner']]) { room.store.dmConsents.request('commons', from, to, 'fixture'); room.store.dmConsents.decide('commons', to, from, 'approve'); }
  const origin = `http://127.0.0.1:${server.address().port}`, connection = { origin, roomId: 'commons', memberId: 'producer', token: room.keys.producer };
  configure(f.store, { ...policy(f.store), roomGrants: [{ origin, room: 'commons', member: 'producer', requesters: ['owner'], capabilities: ['process-data'] }] });
  async function post(path, body) { const r = await fetch(origin + '/api/rooms/commons' + path, { method: 'POST',
    headers: { Authorization: `Bearer ${room.keys.owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.ok, true, await r.clone().text()); return r.json(); }
  const bytes = Buffer.from('from room');
  await post('/files', { id: 'input-file', filename: 'input.txt', mediaType: 'text/plain', data: bytes.toString('base64') });
  const dataInputs = [{ name: 'room.txt', kind: 'room-file', id: 'input-file', sha256: digest(bytes) }];
  for (const id of ['request-one', 'request-wrong']) room.store.command(room.keys.owner, 'commons', { id, type: 'message.posted', data: {
    messageId: id, toMemberId: 'producer', requestKind: 'reply', body: prefix + JSON.stringify({ version: 1, capability: 'process-data', input: {}, dataInputs }) } });
  await post('/files/input-file/commit', { messageId: 'request-one' });
  await runRoomCapability(f.store, { connection, requestMessageId: 'request-one', observeResources: f.observation });
  const result = JSON.parse(f.store.db.prepare("SELECT result FROM jobs WHERE state='completed'").get().result);
  assert.equal(readFileSync(join(result.artifactDirectory, 'result.txt'), 'utf8'), 'from room');
  assert.equal(result.dataInputs[0].provenance.messageId, 'request-one');
  await runRoomCapability(f.store, { connection, requestMessageId: 'request-wrong', observeResources: f.observation });
  const failure = JSON.parse(f.store.db.prepare("SELECT result FROM jobs WHERE state='needs_attention'").get().result);
  assert.equal(failure.error, 'data_attachment_scope_mismatch'); assert.equal(failure.steps.length, 0);
});
