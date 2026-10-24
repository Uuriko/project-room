import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../scripts/room-evolution.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { runCapabilityHost } from '../client/evolution/host.mjs';
import { readCodexHostStatus, stopCodexHost } from '../client/codex-host-status.mjs';
const connection = { origin: 'https://room.example', roomId: 'room', memberId: 'agent', token: 'x'.repeat(43) };
const expectedScope = { origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId };
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'room-host-adapter-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'journal.sqlite'); }
const stopped = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
test('native stop command cancels service, then writes a private confirmed receipt', async t => {
  const journal = fixture(t); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const run = runCapabilityHost({ journal, connection, expectedScope, service: async ({ signal }) => { entered(); await stopped(signal); } });
  await ready;
  const live = readCodexHostStatus(journal);
  assert.equal(live.fresh, true); assert.equal(live.memberId, 'agent'); assert.equal(live.protocol, 'unverified');
  assert.equal(stopCodexHost(journal).stopRequested, true);
  assert.deepEqual(await run, { stopped: true, executionGranted: false });
  const path = journal + '.watch/status.json';
  const receipt = JSON.parse(readFileSync(path));
  assert.equal(receipt.phase, 'stopped'); assert.equal(statSync(path).mode & 0o077, 0);
  assert.equal(readCodexHostStatus(journal).processState, 'stopped');
  assert.equal(JSON.stringify(receipt).includes(connection.token), false);
});
test('second owner is refused and service is never started', async t => {
  const journal = fixture(t), controller = new AbortController(); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const run = runCapabilityHost({ journal, connection, expectedScope, signal: controller.signal,
    service: async ({ signal }) => { entered(); await stopped(signal); } });
  await ready;
  try { await assert.rejects(runCapabilityHost({ journal, connection, expectedScope, service: () => assert.fail('duplicate service') })); }
  finally { controller.abort(); await run; }
});
test('failure and unrequested exit remain recovery-pending, not confirmed stopped', async t => {
  for (const service of [async () => { throw Error('fixture failure'); }, async () => {}]) {
    const journal = fixture(t);
    await assert.rejects(runCapabilityHost({ journal, connection, expectedScope, service }));
    const receipt = JSON.parse(readFileSync(journal + '.watch/status.json'));
    assert.equal(receipt.phase, 'recovery_pending');
    assert.equal(readCodexHostStatus(journal).processState, 'stopped');
  }
});
test('wrong identity and pre-cancelled starts do not invoke a service', async t => {
  const service = () => assert.fail('must not start');
  await assert.rejects(runCapabilityHost({ journal: fixture(t), connection, expectedScope: { ...expectedScope, memberId: 'other' }, service }), /connection changed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCapabilityHost({ journal: fixture(t), connection, expectedScope, signal: controller.signal, service }));
});

test('separate process follows the existing native stop/status protocol', { timeout: 5000 }, async t => {
  const { spawn } = await import('node:child_process');
  const journal = fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/evolution-host.mjs', import.meta.url)), journal], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', chunk => { if (chunk.toString() === 'ready\n') resolve(); else reject(Error('Unexpected readiness')); });
    child.once('exit', () => reject(Error('Exited before ready')));
  });
  const live = readCodexHostStatus(journal);
  assert.equal(live.pid, child.pid); assert.equal(live.fresh, true);
  stopCodexHost(journal);
  assert.deepEqual(await exit, { code: 0, signal: null });
  const receipt = JSON.parse(readFileSync(journal + '.watch/status.json'));
  assert.equal(receipt.phase, 'stopped'); assert.equal(receipt.pid, child.pid);
});

test('actual capability watcher authenticates to a local Room and stops through native control', { timeout: 10000 }, async t => {
  const { createAcceptanceFixture } = await import('../scripts/acceptance-fixture.mjs');
  const { createRoomServer } = await import('../server/http.mjs');
  const { openEvolution } = await import('../client/evolution/store.mjs');
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const journal = fixture(t), store = openEvolution(journal + '.broker');
  t.after(() => store.db.close());
  const connection = { origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'producer', token: f.keys.producer };
  const expectedScope = { origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId };
  let observed;
  const streaming = new Promise(resolve => { observed = resolve; });
  server.on('request', req => { if (req.url.startsWith('/api/rooms/commons/stream?')) observed(); });
  const controller = new AbortController();
  const connectionDirectory = journal + '.connection';
  saveAgentConnection(connectionDirectory, { version: 1, ...connection });
  const run = command(store, 'room-host', { journal, connectionDirectory, expectedScope, intervalMs: 1000 }, controller.signal);
  try {
    await streaming;
    assert.equal(readCodexHostStatus(journal).fresh, true);
    stopCodexHost(journal);
    assert.equal((await run).stopped, true);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0, 'an idle queue must not invent work');
  } finally { controller.abort(); await run; }
});
