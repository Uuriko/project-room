// Listener side of ack=cursor (#6161/#6163): the wake client can tell the
// server "everything up to this cursor is handled", only as an explicit opt-in,
// only with the listener lease token, and never by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { main } from '../scripts/agent-wake.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

async function fixture(t, count = 52) {
  const store = new RoomStore(':memory:'), owner = store.identities.create('Wake owner');
  new AgentRooms(store).create(owner.secret, { roomId: 'ack-room', title: 'Ack', purpose: 'ack=cursor listener side' });
  const alias = store.identities.create('Linked alias');
  linkWithProof(store, owner.secret, 'ack-room', alias, { memberId: 'listener-member', displayName: 'Alias', permissions: [] });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const connection = { origin: 'http://127.0.0.1:' + server.address().port, roomId: 'ack-room', memberId: 'listener-member', token: alias.secret };
  const hb = store.agentHeartbeats, agentId = alias.identityId;
  hb.enqueueWake({ agentId, kind: 'ask', roomId: 'ack-room', messageId: 'obligation' });
  for (let i = 0; i < count; i++) hb.enqueueWake({ agentId, kind: 'mention', roomId: 'ack-room', messageId: 'm' + String(i).padStart(3, '0') });
  const pending = () => hb.pendingWakes(agentId, { limit: 50 }).length;
  const total = () => store.db.prepare('SELECT COUNT(*) n FROM agent_wake_signals WHERE agent_id=? AND delivered_at IS NULL').get(agentId).n;
  return { store, connection, agentId, pending, total, client: new AgentWakeClient({ connection }) };
}

test('a cursor alone never acknowledges; ackThrough acks only the doorbells of the handled page, not obligations', async t => {
  const { client, total } = await fixture(t);
  const first = await client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0 });
  assert.equal(first.more, true); assert.ok(first.nextCursor);
  assert.equal(first.acknowledgedThroughCursor, null);
  assert.equal(total(), 53);
  // Crash before handling: the next run only pages; nothing is acknowledged.
  const second = await client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0, cursor: first.nextCursor });
  assert.equal(second.acknowledgedThroughCursor, null); assert.equal(total(), 53);
  // The page ending at the cursor is fully handled: ack it by cursor.
  const acked = await client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0, cursor: first.nextCursor, ackThrough: true });
  assert.equal(acked.acknowledgedThroughCursor, first.nextCursor);
  const obligation = first.pendingWakes.filter(row => row.kind === 'ask').length;
  assert.equal(obligation, 1, 'the obligation was on the handled page');
  assert.equal(total(), 4, 'only the 49 mention doorbells settle; the ask and the 3 after the cursor stay pending');
  assert.equal(acked.pendingWakes.length, 3, 'the page after the cursor still carries the unhandled tail');
});

test('ackThrough needs a cursor, a valid one, and the lease: misuse is refused before any acknowledgement', async t => {
  const { client, store, connection, agentId, total } = await fixture(t);
  await assert.rejects(client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0, ackThrough: true }), error => error.code === 'invalid_config');
  await assert.rejects(client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0, cursor: 'bad cursor!', ackThrough: true }), error => error.code === 'invalid_config');
  await assert.rejects(client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0, cursor: 'abc', ackThrough: 'yes' }), error => error.code === 'invalid_config');
  const first = await client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0 });
  // A different host does not hold the lease: contended, so nothing is acked.
  const other = new AgentWakeClient({ connection });
  const contended = await other.wait({ hostId: 'desktop', cadenceSeconds: 60, waitMs: 0, cursor: first.nextCursor, ackThrough: true });
  assert.equal(contended.status, 'listener_contended'); assert.equal(contended.acknowledged, false);
  assert.equal(total(), 53);
  void store; void agentId;
});

test('the CLI only accepts --ack cursor', async () => {
  const lines = [];
  assert.equal(await main(['wait', '--host', 'laptop', '--cadence-seconds', '60', '--cursor', 'abc', '--ack', 'bogus'], { env: {}, write: line => lines.push(line) }), 1);
  assert.match(lines.join(''), /usage_error/);
});
