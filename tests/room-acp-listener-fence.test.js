import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../room-acp/src/bridge.mjs';
import { RoomClient } from '../room-acp/src/room.mjs';
import { join } from '../room-acp/src/join.mjs';
import { startRoom } from './room-acp-fixture.mjs';

async function setup(t) {
  const fixture = await startRoom(t);
  const connection = await join({ link: fixture.invite().link, displayName: 'Fenced agent', env: fixture.env });
  const client = new RoomClient(connection);
  const lease = (await client.heartbeat({ hostId: 'first' })).listener;
  assert.equal(lease.acquired, true);
  const token = lease.fencingToken;
  const takeover = () => {
    fixture.f.store.agentHeartbeats.releaseListenerLease({ agentId: connection.identityId, roomId: connection.roomId, fencingToken: token });
    return fixture.f.store.agentHeartbeats.acquireListenerLease({ agentId: connection.identityId, roomId: connection.roomId, listenerId: 'replacement' });
  };
  return { fixture, connection, client, token, takeover };
}
const stale = error => error.status === 409 && error.code === 'stale_listener';

test('listener validation is read-only and old token cannot post after takeover', async t => {
  const { fixture, client, token, takeover } = await setup(t);
  const before = fixture.f.store.db.prepare('SELECT * FROM agent_wake_listener_leases').all();
  assert.equal((await client.checkListener(token)).listener.valid, true);
  assert.deepEqual(fixture.f.store.db.prepare('SELECT * FROM agent_wake_listener_leases').all(), before);
  const replyToId = fixture.say('Please work');
  await client.post({ body: 'valid result', replyToId, listenerToken: token });
  const replacement = takeover();
  assert.equal(replacement.acquired, true);
  await assert.rejects(client.checkListener(token), stale);
  await assert.rejects(client.post({ body: 'stale result', replyToId, listenerToken: token }), stale);
  assert.equal(fixture.messages().some(message => message.body === 'stale result'), false);
  assert.equal((await client.checkListener(replacement.fencingToken)).listener.valid, true);
  // Ordinary clients still use their credential without opting into a fence.
  await client.post({ body: 'ordinary client', replyToId });
});

test('listener fence rejects missing leases, empty tokens and another identity token', async t => {
  const { fixture, client, token } = await setup(t);
  const other = await join({ link: fixture.invite().link, displayName: 'Other agent', env: fixture.env });
  const otherClient = new RoomClient(other);
  const otherToken = (await otherClient.heartbeat({ hostId: 'other' })).listener.fencingToken;
  await assert.rejects(client.post({ body: 'wrong identity', listenerToken: otherToken }), stale);
  await assert.rejects(client.post({ body: 'empty token', listenerToken: '' }), error => error.status === 422);
  const wrongRoom = fixture.f.store.agentHeartbeats.acquireListenerLease({ agentId: other.identityId, roomId: 'different-room', listenerId: 'different-room-host' });
  await assert.rejects(otherClient.post({ body: 'wrong room token', listenerToken: wrongRoom.fencingToken }), stale);
  await assert.rejects(client.request('/api/agent-heartbeats?roomId=other-room', { listenerToken: token }), error => error.status === 403);
  fixture.f.store.agentHeartbeats.releaseListenerLease({ agentId: other.identityId, roomId: other.roomId, fencingToken: otherToken });
  await assert.rejects(otherClient.post({ body: 'missing lease', listenerToken: otherToken }), stale);
});

test('claim note mutation rejects a stale listener in its transaction', async t => {
  const { fixture, connection, client, token, takeover } = await setup(t);
  const response = await fetch(`${fixture.origin}/api/rooms/commons/work-claims`, {
    method: 'POST', headers: { authorization: `Bearer ${fixture.ownerKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fenced-work', title: 'Fenced work', assignee: connection.memberId }),
  });
  assert.equal(response.status, 201);
  await client.claimNote('fenced-work', 'valid note', 'valid-note', token);
  takeover();
  await assert.rejects(client.claimNote('fenced-work', 'stale note', 'stale-note', token), stale);
  assert.equal((await client.claim('fenced-work')).history.some(entry => entry.note === 'stale note'), false);
});

test('cached bridge lease cannot execute after takeover; takeover after precheck cannot post', async t => {
  const { fixture, connection, token, takeover } = await setup(t);
  let prompts = 0;
  const bridge = new Bridge({ connection, persistSessions: false, host: {
    session: async () => ({ sessionId: 's', created: true }),
    prompt: async () => { prompts++; return { recorder: { text: 'completed', tools: new Map() } }; },
  } });
  bridge.fencingToken = token;
  bridge.leaseRenewAt = Date.now() + 60000;
  const root = fixture.say('work');
  const post = bridge.room.post.bind(bridge.room);
  bridge.room.post = async args => { takeover(); return post(args); };
  await bridge.turn(root, [{ signalId: 'first', messageId: root, body: 'work' }]);
  assert.equal(prompts, 1);
  assert.equal(fixture.messages().filter(message => message.authorId === connection.memberId).length, 0);
  await bridge.turn(root, [{ signalId: 'second', messageId: root, body: 'next' }]);
  assert.equal(prompts, 1);
  assert.equal(bridge.stats.acked, 0);
});

test('expired listener token fails even before another laptop acquires it', async t => {
  const { fixture, client, token } = await setup(t);
  fixture.f.store.db.prepare('UPDATE agent_wake_listener_leases SET lease_expires_at=0 WHERE fencing_token=?').run(token);
  await assert.rejects(client.checkListener(token), stale);
  await assert.rejects(client.post({ body: 'expired runtime', listenerToken: token }), stale);
});
