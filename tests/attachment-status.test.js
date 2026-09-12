import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { attachmentLimits } from '../server/attachments.mjs';

async function setup(t) {
  let now = Date.now();
  const store = new RoomStore(':memory:', { now: () => now }); store.initialize(initialRoom('files'));
  const token = store.issueAccessKey('files', 'owner');
  store.command(token, 'files', { id: 'guest', type: 'member.added', data: { memberId: 'guest', displayName: 'Guest', kind: 'human', permissions: [] } });
  const guest = store.issueAccessKey('files', 'guest');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stage = id => store.attachments.stage(token, 'files', { id, filename: 'private-name.txt', mediaType: 'text/plain', bytes: new Uint8Array([0, 255, 7]) });
  const status = (id, key = token, method = 'GET') => fetch(`${origin}/api/rooms/files/attachments/${id}/status`, { method, headers: { Authorization: `Bearer ${key}` } });
  return { store, token, guest, stage, status, advance: ms => { now += ms; } };
}
test('upload status is owner-only metadata with no mutation, bytes or public caching', async t => {
  const f = await setup(t), receipt = f.stage('file');
  const before = f.store.db.prepare('SELECT * FROM room_attachments').get();
  const response = await f.status('file'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...receipt, messageId: null });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const denied = await f.status('file', f.guest); assert.equal(denied.status, 404);
  assert.ok(!(await denied.text()).includes('private-name'));
  assert.equal((await f.status('missing')).status, 404);
  const head = await f.status('file', f.token, 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await f.status('file', f.token, 'PUT')).status, 405);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM room_attachments').get(), before);
});
test('status distinguishes committed, deleted, discarded and expired without restoring bytes', async t => {
  const f = await setup(t); f.stage('committed'); f.stage('discarded'); f.stage('expired');
  f.store.command(f.token, 'files', { id: 'post', type: 'message.posted', data: { messageId: 'message', body: '', attachmentIds: ['committed'] } });
  let receipt = await (await f.status('committed')).json(); assert.equal(receipt.state, 'committed'); assert.equal(receipt.messageId, 'message');
  f.store.command(f.token, 'files', { id: 'delete', type: 'message.deleted', data: { messageId: 'message', expectedMessageRevision: 0 } });
  assert.equal((await (await f.status('committed')).json()).state, 'deleted');
  f.store.attachments.discard(f.token, 'files', 'discarded');
  assert.equal((await (await f.status('discarded')).json()).state, 'discarded');
  f.advance(attachmentLimits.lifetimeMs);
  assert.equal((await (await f.status('expired')).json()).state, 'expired');
  assert.equal(f.store.db.prepare("SELECT state FROM room_attachments WHERE id='expired'").get().state, 'staged', 'expiry status is read-only');
});
test('status cannot report corrupt staged bytes as ready', async t => {
  const f = await setup(t); f.stage('file');
  f.store.transaction(() => f.store.db.prepare("UPDATE room_attachments SET bytes=? WHERE id='file'").run(new Uint8Array([1, 2, 3])));
  const response = await f.status('file'); assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'attachment_corrupt');
});
