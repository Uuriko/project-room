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
