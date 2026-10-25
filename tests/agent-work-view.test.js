// Owns the HTTP behavior of server/routes/agent-work.mjs through the real dispatcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';

test('agent work view combines current membership and private open work without bodies or mutations', async t => {
  const store = new RoomStore(':memory:'), rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen'), worker = store.identities.create('Worker'), other = store.identities.create('Riley');
  rooms.create(owner.secret, { roomId: 'commons', title: 'Work view', purpose: 'Test', kind: 'personal' });
  for (const identity of [worker, other]) {
    store.identities.link(owner.secret, 'commons', { identityId: identity.identityId, displayName: identity === worker ? 'Worker' : 'Riley', permissions: [] });
    store.dmConsents.request('commons', owner.identityId, identity.identityId, 'Fixture');
    store.dmConsents.decide('commons', identity.identityId, owner.identityId, 'approve');
  }
  for (let i = 0; i < 25; i++) store.command(owner.secret, 'commons', { id: `history-${i}`, type: 'message.posted', data: {
    messageId: `history-${i}`, body: 'history-body-sentinel-' + 'x'.repeat(1000) } });
  const question = (id, recipient) => store.command(owner.secret, 'commons', { id, type: 'message.posted', data: {
    messageId: id, toMemberId: recipient, requestKind: 'reply', body: 'private-question-sentinel' } });
  question('open', worker.identityId); question('closed', worker.identityId); question('other-only', other.identityId);
  store.command(owner.secret, 'commons', { id: 'cancel', type: 'reply_request.cancelled', data: {
    requestMessageId: 'closed', expectedRequestRevision: 0, reason: 'No longer needed' } });
  const context = store.replyRequests.selected(worker.secret, 'commons', 'open');
  const run = { requestMessageId: 'open', attemptId: 'original', expectedRequestRevision: context.request.revision, contextEventId: context.request.contextEventId };
  store.requestRuns.apply(worker.secret, 'commons', { ...run, action: 'claim' });
  store.requestRuns.apply(worker.secret, 'commons', { ...run, action: 'needs_attention' });
  const server = createRoomServer({ store });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); store.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = (token = worker.secret, suffix = '') => fetch(origin + '/api/rooms/commons/agent-work' + suffix,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const before = store.room('commons').sequence;
  const response = await read(); assert.equal(response.status, 200, await response.clone().text());
  const text = await response.text(), value = JSON.parse(text);
  assert.equal(value.contractVersion, 1); assert.equal(value.roomId, 'commons'); assert.equal(value.viewerId, worker.identityId);
  assert.equal(value.member.id, worker.identityId); assert.equal(value.member.kind, 'agent'); assert.equal(value.member.active, true);
  assert.equal(value.member.revision, store.room('commons').state.members[worker.identityId].revision);
  assert.deepEqual(value.member.permissions, []); assert.equal(value.member.delegatedAdmin, false);
  assert.equal(value.ownerId, owner.identityId); assert.equal(value.executionGranted, false);
  assert.equal(value.evaluatedThrough, before);
  assert.deepEqual(value.requests, store.replyRequests.list(worker.secret, 'commons').requests);
  assert.deepEqual(value.runs, store.requestRuns.list(worker.secret, 'commons').runs);
  assert.deepEqual(value.requests.map(request => request.id), ['open']);
  for (const secret of [owner.secret, worker.secret, other.secret, 'history-body-sentinel', 'private-question-sentinel', 'other-only']) assert.equal(text.includes(secret), false);
  assert.ok(Buffer.byteLength(text) < 4096);
  assert.equal(store.room('commons').sequence, before);
  const ownerView = await (await read(owner.secret)).json(); assert.equal(ownerView.member.id, ownerView.ownerId);
  assert.equal((await read(null)).status, 401);
  assert.equal((await read(worker.secret, '?unexpected=1')).status, 422);
  const readKey = store.agentPlugin.issueApiKey({ identityId: worker.identityId, scopes: ['rooms:read'] });
  const writeKey = store.agentPlugin.issueApiKey({ identityId: worker.identityId, scopes: ['rooms:write'] });
  assert.equal((await read(`rak_${readKey.secret}`)).status, 200);
  assert.equal((await read(`rak_${writeKey.secret}`)).status, 403);
  store.identities.unlink(owner.secret, 'commons', worker.identityId);
  assert.ok([401, 403].includes((await read()).status));
  t.diagnostic(`combined view ${Buffer.byteLength(text)} bytes for room with 25KB message bodies`);
});
