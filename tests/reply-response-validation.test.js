import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createHostedRoomMcp } from '../server/mcp-room-profile.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

function fixture(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const rooms = new AgentRooms(store), owner = store.identities.create('Mira'), peer = store.identities.create('Quill');
  const created = rooms.create(owner.secret, { title: 'Response validation', purpose: 'Test replies', displayName: 'Mira' });
  const roomId = created.roomId;
  const invite = store.invites.create(owner.secret, roomId, { profile: 'collaborate', displayName: 'Quill' }, null);
  const joined = store.invites.redeem(invite.code, { displayName: 'Quill', identitySecret: peer.secret });
  const peerId = joined.memberId ?? joined.member?.id;
  setTier(store.db, roomId, peerId, 't2_standard', { updatedBy: created.ownerMemberId, nowMs: Date.now() });
  const mcp = createHostedRoomMcp(store);
  const call = async (secret, name, args) => {
    const response = await mcp({ jsonrpc: '2.0', id: 'test', method: 'tools/call', params: { name, arguments: { roomId, ...args } } }, { authorization: `Bearer ${secret}` });
    assert.ok(response.result, JSON.stringify(response));
    return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
  };
  return { store, roomId, owner, peer, peerId, call };
}
async function open(f, id) {
  const requested = await f.call(f.owner.secret, 'room_request_reply', { requestId: id, toMemberId: f.peerId, body: 'Please answer' });
  assert.equal(requested.status, 'recorded', JSON.stringify(requested));
  const context = await f.call(f.peer.secret, 'room_read_request', { requestMessageId: requested.requestMessageId });
  return { requested, args: context.responseActions[0].arguments };
}
test('hosted MCP missing response body is422 for answered and declined, without changing the request', async t => {
  const f = fixture(t), { requested, args } = await open(f, 'missing-body');
  const before = f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get(f.roomId).sequence;
  for (const responseOutcome of ['answered', 'declined']) {
    const input = { ...args, requestId: 'missing-' + responseOutcome, responseOutcome }; delete input.body;
    const result = await f.call(f.peer.secret, 'room_respond_to_request', input);
    assert.equal(result.status, 422, JSON.stringify(result));
    assert.equal(result.code, 'invalid_reply_action'); assert.match(result.message, /body/);
  }
  assert.equal(f.store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get(f.roomId).sequence, before);
  const current = await f.call(f.peer.secret, 'room_read_request', { requestMessageId: requested.requestMessageId });
  assert.equal(current.request.status, 'open');
});
test('complete response and non-message cancel stay supported; unexpected command errors remain500', async t => {
  const f = fixture(t), first = await open(f, 'complete-body');
  const realCommand = f.store.command;
  f.store.command = () => { throw new Error('PRIVATE internal fault'); };
  const failed = await f.call(f.peer.secret, 'room_respond_to_request', { ...first.args, requestId: 'internal-failure', body: 'Answer' });
  assert.equal(failed.status, 500); assert.equal(failed.code, 'internal'); assert.doesNotMatch(failed.message, /PRIVATE/);
  f.store.command = realCommand;
  const complete = await f.call(f.peer.secret, 'room_respond_to_request', { ...first.args, requestId: 'complete-answer', body: 'Answer' });
  assert.equal(complete.status, 'recorded', JSON.stringify(complete));
  const second = await open(f, 'cancel-body');
  const cancelled = await f.call(f.owner.secret, 'room_cancel_request', { requestId: 'cancel-request', requestMessageId: second.requested.requestMessageId, expectedRequestRevision: 0, reason: 'No longer needed' });
  assert.equal(cancelled.status, 'recorded', JSON.stringify(cancelled));
});
