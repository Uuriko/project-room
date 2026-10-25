// Opt-in growth/fidelity qualification, separate from latency measurements.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFixture, loadTree } from './bench/fixture.mjs';

const size = Number(process.argv[2] ?? 8000);
const output = process.argv[3];
assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 100000);
assert.ok(output, 'Explicit report path required');
const directory = mkdtempSync(join(tmpdir(), 'room-capacity-'));
let store;
const report = { size, bodiesAtRest: true, status: 'failed' };
try {
  const meta = await buildFixture({ root: resolve('.'), size, out: directory, bodiesAtRest: true });
  report.seedFailures = meta.failed;
  assert.equal(meta.failed, 0, meta.lastError ?? 'all fixture writes succeed');
  const { RoomStore, T } = await loadTree(resolve('.'));
  const file = join(directory, 'room.sqlite');
  let clock = meta.clock;
  const open = () => new RoomStore(file, { bodiesAtRest: true, now: () => clock });
  store = open();
  const before = structuredClone(store.room(meta.roomId).state.messages);
  assert.equal(before.length, size);
  assert.ok(before.every(m => typeof m.body === 'string' && m.body.length >= 600));
  assert.ok(before.some(m => m.replyToId), 'fixture covers threaded replies');
  store.close(); store = open();
  assert.deepEqual(store.room(meta.roomId).state.messages, before, 'restart retains every body and reply');
  clock += 15000;
  const command = { id: 'capacity-tail', type: T.MESSAGE_POSTED,
    data: { messageId: 'capacity-tail', body: 'Reply after restart', replyToId: 'm1' } };
  store.command(meta.keys[0], meta.roomId, command);
  const sequence = store.room(meta.roomId).sequence;
  store.command(meta.keys[0], meta.roomId, command);
  assert.equal(store.room(meta.roomId).sequence, sequence, 'exact retry is idempotent');
  const messages = structuredClone(store.room(meta.roomId).state.messages);
  assert.equal(messages.length, size + 1);
  assert.deepEqual(store.rebuildProjection(meta.roomId).state.messages, messages, 'replay retains every body and reply');
  report.projectionBytes = store.db.prepare('SELECT length(projection) AS bytes FROM rooms WHERE id=?').get(meta.roomId).bytes;
  report.restartFidelity = true; report.replayFidelity = true; report.exactRetry = true;
  report.messageCount = messages.length; report.status = 'passed';
} catch (error) {
  report.failure = error.message; process.exitCode = 1;
} finally {
  store?.close(); rmSync(directory, { recursive: true, force: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
}
