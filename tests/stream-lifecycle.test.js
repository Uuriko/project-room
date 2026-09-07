import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-stream-lifecycle-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  store.initialize(initialRoom());
  const key = store.issueAccessKey('commons', 'owner'), sequence = store.room('commons').sequence;
  const signals = new Map(), readers = [];
  const server = createRoomServer({ store, streamInterval: 15,
    resolveRequestSignal: req => signals.get(req.headers['x-test-stream'])?.signal });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const controller of signals.values()) controller.abort();
    for (const reader of readers) await reader.cancel().catch(() => {});
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  async function open(id, { aborted = false } = {}) {
    const controller = new AbortController(); signals.set(id, controller);
    if (aborted) controller.abort();
    const response = await fetch(`${origin}/api/rooms/commons/stream?after=${sequence}`, {
      headers: { Authorization: `Bearer ${key}`, 'X-Test-Stream': id }, signal: AbortSignal.timeout(5000)
    });
    const reader = response.status === 200 ? response.body.getReader() : null;
    if (reader) readers.push(reader);
    return { response, reader, controller };
  }
  return { open };
}

test('request cancellation releases only its stream and preserves the three-stream limit', async t => {
  const { open } = await fixture(t);
  const first = await open('first'), second = await open('second'), third = await open('third');
  for (const stream of [first, second, third]) {
    assert.equal(stream.response.status, 200); assert.equal((await stream.reader.read()).done, false);
  }
  const capped = await open('fourth');
  assert.equal(capped.response.status, 429);
  assert.equal((await capped.response.json()).error.code, 'stream_limit');
  first.controller.abort();
  // Drain already-buffered heartbeats; the platform cancellation must end this stream.
  while (!(await first.reader.read()).done) {}
  const replacement = await open('replacement');
  assert.equal(replacement.response.status, 200);
  assert.equal((await second.reader.read()).done, false, 'unrelated peer remains connected');
  assert.equal((await third.reader.read()).done, false, 'third peer remains connected');
});

test('already-aborted and repeated cancelled requests leave no occupied stream slots', async t => {
  const { open } = await fixture(t);
  const ended = await open('already-ended', { aborted: true });
  assert.equal(ended.response.status, 200);
  assert.equal((await ended.reader.read()).done, true);
  for (let visit = 0; visit < 6; visit++) {
    const stream = await open(`visit-${visit}`);
    assert.equal(stream.response.status, 200);
    assert.equal((await stream.reader.read()).done, false);
    stream.controller.abort();
    while (!(await stream.reader.read()).done) {}
  }
});
