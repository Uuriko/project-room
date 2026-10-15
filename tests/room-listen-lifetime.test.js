import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomStore } from '../server/store.mjs';
import { listen } from '../scripts/room-listen.mjs';

async function receiver(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-poll-lifetime-'));
  const store = new RoomStore(':memory:');
  const owner = store.identities.create('Lifetime owner');
  const agent = store.identities.create('Lifetime receiver');
  new AgentRooms(store).create(owner.secret, { roomId: 'lifetime-room', title: 'Lifetime', purpose: 'Synthetic receiving regression' });
  store.identities.link(owner.secret, 'lifetime-room', { identityId: agent.identityId, memberId: 'receiver', displayName: 'Receiver', permissions: [] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const config = join(directory, 'private');
  saveAgentConnection(config, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: 'lifetime-room', memberId: 'receiver', token: agent.secret });
  return { store, agent, config };
}

test('poll listener survives more than 256 handled wakes without consuming the latest wake', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { store, agent, config } = await receiver(t);
  let count = 0;
  const enqueue = () => store.agentHeartbeats.enqueueWake({ agentId: agent.identityId, kind: 'mention', roomId: 'lifetime-room', messageId: `message-${count}` }).signal;
  let current = enqueue();
  const pointers = [], errors = [];
  await listen(['--mode', 'poll', '--host', 'lifetime-host', '--cadence-seconds', '60'], {
    env: { ROOM_AGENT_CONFIG: config }, report: error => errors.push(error),
    output: { write(line, done) {
      const pointer = JSON.parse(line);
      pointers.push(pointer);
      count++;
      if (count < 257) {
        // The consuming host acknowledges handling. The pointer-only listener
        // must not do this itself or retain already-handled ids forever.
        store.agentHeartbeats.ackWakes({ agentId: agent.identityId, signalIds: [pointer.signalId] });
        current = enqueue();
      }
      done();
    } },
    // Advance synthetic wall time instead of waiting four hours. This keeps
    // the real HTTP rate limit and heartbeat code active in every iteration.
    delay: async () => { now += 60001; if (count === 257) process.emit('SIGTERM'); },
  });
  assert.equal(pointers.length, 257, 'handled historical wake ids must not exhaust the pending limit');
  assert.deepEqual(errors, []);
  assert.equal(new Set(pointers.map(pointer => pointer.signalId)).size, 257);
  assert.deepEqual(store.agentHeartbeats.pendingWakes(agent.identityId).map(signal => signal.signalId), [current.signalId],
    'the listener emits pointers and leaves handling acknowledgement to the host');
});


test('an unacknowledged wake on the current pending page emits once across repeated polls', async t => {
  const { store, agent, config } = await receiver(t);
  const wake = store.agentHeartbeats.enqueueWake({ agentId: agent.identityId, kind: 'mention', roomId: 'lifetime-room', messageId: 'still-pending' }).signal;
  const pointers = [], errors = [];
  let polls = 0;
  await listen(['--mode', 'poll', '--host', 'unacked-host', '--cadence-seconds', '60'], {
    env: { ROOM_AGENT_CONFIG: config }, report: error => errors.push(error),
    output: { write(line, done) { pointers.push(JSON.parse(line)); done(); } },
    delay: async () => { if (++polls === 3) process.emit('SIGTERM'); },
  });
  assert.deepEqual(errors, []);
  assert.equal(polls, 3);
  assert.deepEqual(pointers.map(pointer => pointer.signalId), [wake.signalId]);
  assert.deepEqual(store.agentHeartbeats.pendingWakes(agent.identityId).map(signal => signal.signalId), [wake.signalId]);
});
