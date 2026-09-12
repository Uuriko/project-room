import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { once } from 'node:events';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { attachmentLimits } from '../server/attachments.mjs';
import { diagnosticRoute } from '../server/diagnostics.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('files')); store.initialize(initialRoom('other'));
  const token = store.issueAccessKey('files', 'owner');
  store.command(token, 'files', { id: randomUUID(), type: 'member.added', data: { memberId: 'guest', displayName: 'Guest', kind: 'human', permissions: [] } });
  const guest = store.issueAccessKey('files', 'guest'), other = store.issueAccessKey('other', 'owner');
  const server = createRoomServer({ store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = '/api/rooms/files/attachments/file';
  const headers = { Authorization: `Bearer ${token}`, 'X-File-Name': encodeURIComponent('résumé.html'), 'Content-Type': 'text/html' };
  const put = (bytes = new Uint8Array([0, 255, 7]), overrides = {}) => fetch(origin + path, { method: 'PUT', headers, body: bytes, ...overrides });
  const commit = async () => {
    const response = await fetch(origin + '/api/rooms/files/commands', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), type: 'message.posted', data: { messageId: 'message', body: 'A file', attachmentIds: ['file'] } }) });
    assert.equal(response.status, 201, await response.text());
  };
  return { store, server, origin, token, guest, other, path, headers, put, commit };
}

test('binary upload retries, message commitment, safe GET/HEAD and deletion', async t => {
  const f = await fixture(t), bytes = new Uint8Array([0, 255, 7]);
  const first = await f.put(bytes); assert.equal(first.status, 200);
  assert.deepEqual(await (await f.put(bytes)).json(), await first.json());
  assert.equal((await fetch(f.origin + f.path, { headers: f.headers })).status, 404);
  await f.commit();
  const result = await fetch(f.origin + f.path, { headers: { Authorization: `Bearer ${f.guest}` } });
  assert.equal(result.status, 200);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  assert.equal(result.headers.get('content-type'), 'application/octet-stream');
  assert.equal(result.headers.get('content-disposition'), `attachment; filename="download"; filename*=UTF-8''r%C3%A9sum%C3%A9.html`);
  assert.equal(result.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const head = await fetch(f.origin + f.path, { method: 'HEAD', headers: f.headers });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '3'); assert.equal(await head.text(), '');
  assert.equal((await fetch(f.origin + f.path, { method: 'DELETE', headers: f.headers })).status, 409);
  f.store.command(f.token, 'files', { id: randomUUID(), type: 'message.deleted', data: { messageId: 'message', expectedMessageRevision: 0 } });
  assert.equal((await fetch(f.origin + f.path, { headers: f.headers })).status, 404);
  assert.equal(f.store.db.prepare('SELECT bytes FROM room_attachments').get().bytes, null);
});

test('file requests require room access and browser write protection', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + f.path)).status, 401);
  assert.equal((await f.put(undefined, { headers: { ...f.headers, Authorization: `Bearer ${f.other}` } })).status, 403);
  assert.equal((await f.put(undefined, { headers: { Cookie: `room_session=${f.token}` } })).status, 401);
  const session = f.store.createSession(f.token);
  const cookie = { Cookie: `room_session=${session.token}`, 'Content-Type': 'text/plain', 'X-File-Name': 'notes.txt' };
  assert.equal((await f.put(undefined, { headers: cookie })).status, 403);
  assert.equal((await f.put(undefined, { headers: { ...cookie, Origin: f.origin } })).status, 403);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 0);
  const allowed = { ...cookie, Origin: f.origin, 'X-CSRF-Token': session.session.csrf, 'X-Session-Binding': session.session.sessionBinding };
  assert.equal((await f.put(undefined, { headers: allowed })).status, 200);
  assert.equal((await fetch(f.origin + f.path, { method: 'DELETE', headers: allowed })).status, 200);
  assert.equal(f.store.db.prepare('SELECT bytes FROM room_attachments').get().bytes, null);
});

test('invalid metadata, encoding and oversized known-length bodies never persist', async t => {
  const f = await fixture(t);
  for (const value of ['%', '..%2Fsecret', '%0D%0AInjected', ''])
    assert.equal((await f.put(undefined, { headers: { ...f.headers, 'X-File-Name': value } })).status, 422);
  assert.equal((await f.put(undefined, { headers: { ...f.headers, 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await f.put(new Uint8Array(attachmentLimits.fileBytes + 1))).status, 413);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 0);
  assert.equal(diagnosticRoute(f.path + '?filename=secret', 'files', f.origin), '/api/rooms/:roomId/attachments/:item');
});

function pending(f, headers = f.headers) {
  let resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  const req = request(f.origin + f.path, { method: 'PUT', headers }, res => {
    res.resume(); res.once('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.write(Buffer.from([1]));
  return { req, done };
}

test('in-flight member admission and revocation are enforced before storage', async t => {
  const f = await fixture(t);
  // Observe the actual server request before testing concurrent admission.
  const arrived = once(f.server, 'request');
  const upload = pending(f, { ...f.headers, Authorization: `Bearer ${f.guest}` });
  await arrived;
  const second = await f.put(undefined, { headers: { ...f.headers, Authorization: `Bearer ${f.guest}` } });
  assert.equal(second.status, 429);
  f.store.command(f.token, 'files', { id: randomUUID(), type: 'member.access_changed', data: { memberId: 'guest', expectedMemberRevision: 0, active: false, permissions: [] } });
  upload.req.end(Buffer.from([2]));
  assert.equal(await upload.done, 401);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 0);
  assert.equal((await f.put()).status, 200);
});

test('chunked oversize is rejected and incomplete uploads never persist', async t => {
  const f = await fixture(t), upload = pending(f);
  upload.req.end(Buffer.alloc(attachmentLimits.fileBytes));
  assert.equal(await upload.done, 413);
  const arrived = once(f.server, 'request'), interrupted = pending(f);
  interrupted.done.catch(() => {});
  const [incoming] = await arrived;
  const closed = new Promise(resolve => incoming.once('close', resolve));
  interrupted.req.destroy();
  await closed;
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 0);
});
