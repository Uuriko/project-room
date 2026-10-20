import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queueRoomPointer, runCodexQueue } from '../client/codex-queue.mjs';
const binding = { origin: 'https://room.example', roomId: 'qa-room', memberId: 'agent-one', threadId: '01a0ee9d-76ed-7e80-acdc-02177dc7ca3c' };
function fixture(t) {
  const journal = mkdtempSync(join(tmpdir(), 'room-queue-'));
  t.after(() => rmSync(journal, { recursive: true, force: true }));
  return { binding, journal, pointer: { roomId: 'qa-room', signalId: 'signal-1', messageId: 'message-1' }, authorize: async () => true };
}
test('acceptance is not execution; restart and concurrent duplicate cannot redispatch', async t => {
  const options = fixture(t); let calls = 0;
  const run = async args => { calls++; assert.equal(args[0], 'queue'); assert.equal(args[2], binding.threadId); return 'accepted'; };
  const results = await Promise.all([queueRoomPointer({ ...options, run }), queueRoomPointer({ ...options, run })]);
  assert.equal(calls, 1); assert.equal(results[0].execution, 'not_observed');
  assert.equal((await queueRoomPointer({ ...options, run })).duplicate, true); assert.equal(calls, 1);
});
test('unknown delivery stays unknown across restart without retry', async t => {
  const options = fixture(t); let calls = 0;
  const run = async () => { calls++; throw new Error('secret diagnostic'); };
  const first = await queueRoomPointer({ ...options, run });
  assert.equal(first.status, 'unknown'); assert.ok(!JSON.stringify(first).includes('secret'));
  assert.equal((await queueRoomPointer({ ...options, run })).status, 'unknown'); assert.equal(calls, 1);
});
test('revoked authority prevents dispatch, including after previous acceptance', async t => {
  const options = fixture(t); let calls = 0;
  const run = async () => { calls++; return 'accepted'; };
  await queueRoomPointer({ ...options, run });
  await assert.rejects(queueRoomPointer({ ...options, run, authorize: async () => false }), /access_denied/);
  assert.equal(calls, 1);
});
test('reject room mismatch, injected fields and unsafe identifiers before dispatch', async t => {
  const options = fixture(t);
  for (const pointer of [{ ...options.pointer, roomId: 'other' }, { ...options.pointer, body: 'do something' }, { ...options.pointer, signalId: 'x\nattack' }]) {
    await assert.rejects(queueRoomPointer({ ...options, pointer, run: () => assert.fail('dispatched') }), /invalid_pointer/);
  }
});
test('same signal with changed payload is refused', async t => {
  const options = fixture(t); await queueRoomPointer({ ...options, run: async () => 'accepted' });
  await assert.rejects(queueRoomPointer({ ...options, pointer: { ...options.pointer, messageId: 'other' }, run: () => assert.fail('dispatched') }), /pointer_conflict/);
});

test('missing executable and killed command never claim acceptance', async t => {
  const { journal } = fixture(t);
  assert.equal(await runCodexQueue([], { executable: join(journal, 'missing') }), 'unknown');
  const executable = join(journal, 'held');
  writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 10\n', { mode: 0o700 });
  assert.equal(await runCodexQueue([], { executable, timeoutMs: 30 }), 'unknown');
});
test('transport only accepts a clean process exit', async () => {
  assert.equal(await runCodexQueue([], { executable: '/usr/bin/true' }), 'accepted');
  assert.equal(await runCodexQueue([], { executable: '/usr/bin/false' }), 'unknown');
});

test('foreground driver uses scoped Room wakes, retains ACK and stops after revocation', { timeout: 30000 }, async t => {
  const { RoomStore } = await import('../server/store.mjs');
  const { initialRoom } = await import('../server/bootstrap.mjs');
  const { createRoomServer } = await import('../server/http.mjs');
  const { connectRoom } = await import('../client/agent-setup.mjs');
  const { readAgentConnection } = await import('../client/agent-connection.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFileSync } = await import('node:fs');
  const { journal } = fixture(t), store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const owner = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const invite = store.invites.create(owner, 'commons', { profile: 'chat', displayName: 'Probe' });
  const setup = await connectRoom({ origin, directory: join(journal, 'identity'), name: 'Probe', accept: true, target: invite.code });
  const connection = readAgentConnection(setup.configDirectory);
  const signal = store.agentHeartbeats.enqueueWake({ agentId: setup.identityId, kind: 'mention', roomId: 'commons', messageId: 'probe-message' }).signal;
  store.agentHeartbeats.enqueueWake({ agentId: setup.identityId, kind: 'mention', roomId: 'commons', messageId: 'second-message' });
  const log = join(journal, 'calls');
  writeFileSync(join(journal, 'codex'), '#!/bin/sh\nprintf x >> "$ROOM_TEST_QUEUE_LOG"\n', { mode: 0o700 });
  const args = ['scripts/codex-queue-pointer.mjs', '--thread', binding.threadId, '--journal', join(journal, 'receipts'), '--host', 'queue-probe'];
  const env = { ...process.env, PATH: journal + ':' + process.env.PATH, ROOM_AGENT_CONFIG: setup.configDirectory, ROOM_TEST_QUEUE_LOG: log };
  for (const key of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete env[key];
  const execute = () => promisify(execFile)(process.execPath, args, { env, timeout: 15000 });
  const output = (await execute()).stdout;
  const first = JSON.parse(output.trim());
  assert.equal(first.status, 'accepted'); assert.equal(first.signalId, signal.signalId);
  assert.equal(store.agentHeartbeats.pendingWakes(setup.identityId, { roomId: 'commons' }).length, 2, 'transport success never handles Room wakes');
  const second = (await execute()).stdout.trim().split('\n').map(JSON.parse);
  assert.equal(second[0].duplicate, true);
  assert.equal(second.length, 2, 'accepted first signal must not starve the next');
  assert.equal(second[1].duplicate, false);
  assert.equal(second[1].status, 'accepted');
  assert.notEqual(second[1].signalId, first.signalId);
  assert.equal(readFileSync(log, 'utf8'), 'xx', 'restart only delivers the next signal');
  assert.ok((await execute()).stdout.trim().split('\n').map(JSON.parse).every(row => row.duplicate));
  assert.equal(readFileSync(log, 'utf8'), 'xx', 'neither signal is redelivered');
  assert.equal(store.agentHeartbeats.pendingWakes(setup.identityId, { roomId: 'commons' }).length, 2);
  assert.ok(!output.includes(connection.token));
  store.identities.unlink(owner, 'commons', setup.identityId);
  await assert.rejects(execute()); assert.equal(readFileSync(log, 'utf8'), 'xx');
});
