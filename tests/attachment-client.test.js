import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomClient } from '../src/client.js';

const bytes = new Uint8Array([0, 255, 5]);
const file = { id: 'file', filename: 'notes.html', byteLength: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') };
function client(fetcher) {
  const value = new RoomClient({ fetcher });
  value.session = { roomId: 'room', member: { id: 'member' }, sessionBinding: 'binding' };
  return value;
}
test('download sends same-origin bound credentials and returns only verified inert bytes', async () => {
  let request;
  const c = client(async (path, options) => { request = { path, options }; return new Response(bytes, { headers: { 'Content-Length': '3' } }); });
  const blob = await c.downloadAttachment(file);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(blob.type, 'application/octet-stream');
  assert.equal(request.path, '/api/rooms/room/attachments/file');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['X-Session-Binding'], 'binding');
  assert.equal(c.fileTransfers.size, 0);
});
test('file size and hash mismatch reject without exposing a blob', async () => {
  for (const response of [new Response(bytes, { headers: { 'Content-Length': '999' } }),
    new Response(new Uint8Array([0, 1, 2])), new Response(new Uint8Array([0])), new Response(new Uint8Array(4))]) {
    const c = client(async () => response);
    await assert.rejects(c.downloadAttachment(file), /match|verified/);
    assert.equal(c.fileTransfers.size, 0);
  }
});
test('oversized streamed responses cancel before accumulating excess chunks', async () => {
  let cancelled = false;
  const c = client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; }
  })));
  await assert.rejects(c.downloadAttachment(file), /size/);
  assert.equal(cancelled, true);
});
test('a late response after room or identity replacement cannot produce a download', async () => {
  let resolve;
  const c = client(() => new Promise(done => { resolve = done; }));
  const download = c.downloadAttachment(file);
  c.session = { ...c.session, roomId: 'other' };
  resolve(new Response(bytes));
  await assert.rejects(download, { name: 'AbortError' });
});
test('disconnect and user cancel abort the underlying request', async () => {
  for (const disconnect of [false, true]) {
    let requestSignal;
    const c = client((path, options) => new Promise((resolve, reject) => {
      requestSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const download = c.downloadAttachment(file, { signal: controller.signal });
    if (disconnect) c.disconnect(); else controller.abort();
    await assert.rejects(download, { name: 'AbortError' });
    assert.equal(requestSignal.aborted, true); assert.equal(c.fileTransfers.size, 0);
  }
});
test('malformed references and stale account ownership never start a request', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return new Response(bytes); });
  for (const invalid of [{ ...file, byteLength: 1048577 }, { ...file, sha256: 'wrong' }, { ...file, id: '../file' }])
    await assert.rejects(c.downloadAttachment(invalid), /Invalid/);
  c.session.authMode = 'account';
  await assert.rejects(c.downloadAttachment(file), /Reopen/);
  assert.equal(calls, 0);
});
test('empty files verify, and HTTP error markup is never surfaced', async () => {
  const empty = { ...file, byteLength: 0, sha256: createHash('sha256').update(new Uint8Array()).digest('hex') };
  assert.equal((await client(async () => new Response(new Uint8Array())).downloadAttachment(empty)).size, 0);
  await assert.rejects(client(async () => new Response('<script>secret</script>', { status: 404 })).downloadAttachment(file),
    error => error.message === 'File unavailable' && error.status === 404);
});
