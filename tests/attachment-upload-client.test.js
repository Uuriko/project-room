import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomClient } from '../src/client.js';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

const bytes = new Uint8Array([0, 255, 7]);
const file = new File([bytes], 'notes.txt', { type: 'text/plain' });
const receipt = { id: 'upload', roomId: 'room', uploaderId: 'owner', filename: 'notes.txt', mediaType: 'text/plain',
  byteLength: 3, sha256: createHash('sha256').update(bytes).digest('hex'), state: 'staged', createdAt: 1, expiresAt: 2 };
const client = fetcher => { const c = new RoomClient({ fetcher }); c.session = { roomId: 'room', member: { id: 'owner' }, csrf: 'csrf', sessionBinding: 'binding' }; return c; };

test('upload sends exact raw bytes and verifies its room-owned receipt', async () => {
  let captured;
  const c = client(async (path, options) => { captured = { path, options }; return Response.json(receipt); });
  assert.deepEqual(await c.uploadAttachment('upload', file), receipt);
  assert.equal(captured.path, '/api/rooms/room/attachments/upload');
  assert.equal(captured.options.method, 'PUT'); assert.deepEqual(captured.options.body, bytes);
  assert.equal(captured.options.headers['X-CSRF-Token'], 'csrf');
  assert.equal(captured.options.headers['X-Session-Binding'], 'binding');
  assert.equal(c.fileTransfers.size, 0);
});
test('mismatched receipt content, owner, state or scope never becomes a successful upload', async () => {
  for (const change of [{ id: 'other' }, { roomId: 'other' }, { uploaderId: 'other' }, { sha256: '0'.repeat(64) },
    { byteLength: 4 }, { state: 'discarded' }, { filename: 'other' }, { mediaType: 'text/html' }, { expiresAt: 0 }]) {
    await assert.rejects(client(async () => Response.json({ ...receipt, ...change })).uploadAttachment('upload', file), /verified/);
  }
});
test('upload receipts are bounded and cancelled on overflow', async () => {
  let cancelled = false;
  const c = client(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } })));
  await assert.rejects(c.uploadAttachment('upload', file), /too large/); assert.equal(cancelled, true);
});
test('cancel before reading never sends; oversized files never allocate or send', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return Response.json(receipt); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(c.uploadAttachment('upload', file, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(c.uploadAttachment('upload', new File([new Uint8Array(1048577)], 'large')), /1 MiB/);
  assert.equal(calls, 0);
});
test('a late upload receipt cannot repopulate a replacement room', async () => {
  let resolve, started;
  const ready = new Promise(done => { started = done; });
  const c = client(() => { started(); return new Promise(done => { resolve = done; }); });
  const operation = c.uploadAttachment('upload', file); await ready;
  c.session = { ...c.session, roomId: 'other' };
  resolve(Response.json(receipt));
  await assert.rejects(operation, { name: 'AbortError' });
});
test('real HTTP browser-session upload retries one staged record without posting a message', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom('room'));
  const access = store.issueAccessKey('room', 'owner'), browserSession = store.createSession(access);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let loseResponse = true;
  const c = new RoomClient({ fetcher: async (path, options) => {
    const response = await fetch(origin + path, { ...options,
      headers: { ...options.headers, Cookie: `room_session=${browserSession.token}`, Origin: origin } });
    if (loseResponse) { loseResponse = false; await response.text(); throw new Error('Response lost'); }
    return response;
  } });
  c.session = browserSession.session;
  await assert.rejects(c.uploadAttachment('upload', file), /Response lost/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 1);
  const first = await c.uploadAttachment('upload', file);
  assert.equal(first.state, 'staged');
  assert.deepEqual(await c.uploadAttachment('upload', file), first);
  assert.equal(store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 1);
  assert.equal(store.room('room').state.messages.length, 0);
  assert.deepEqual(store.attachments.readStaged(access, 'room', 'upload').bytes, bytes);
});
