// Authority refreshes are part of the receiving critical path. A temporary
// context failure must reach the existing retry policy, while revoked access
// must stop without exposing or acknowledging pending pointers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { isTransientWakeError, wakeRetryDelayMs } from '../client/wake-retry.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { serveClaudeRoomChannel } from '../client/claude-channel.mjs';
import { listen } from '../scripts/room-listen.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function fixture(t) {
  const store = new RoomStore(':memory:');
  const owner = store.identities.create('Context retry owner');
  const agent = store.identities.create('Context retry receiver');
  new AgentRooms(store).create(owner.secret, { roomId: 'retry-room', title: 'Retry', purpose: 'Authority read fault injection' });
  linkWithProof(store, owner.secret, 'retry-room', agent, { memberId: 'receiver', displayName: 'Receiver', permissions: [] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: 'retry-room', memberId: 'receiver', token: agent.secret };
  const directory = mkdtempSync(join(tmpdir(), 'wake-context-retry-')), config = join(directory, 'private');
  saveAgentConnection(config, connection);
  const wake = store.agentHeartbeats.enqueueWake({ agentId: agent.identityId, kind: 'mention', roomId: 'retry-room', messageId: 'pending-message' }).signal;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, owner, agent, connection, config, wake };
}
function failingContext({ stage = 1, status = 503, code = 'service_unavailable', network = false, malformed = false } = {}) {
  let contexts = 0, polls = 0;
  return {
    fetch: async (url, options) => {
      if (String(url).includes('/agent-wakes/poll')) polls++;
      if (new URL(url).pathname.endsWith('/context') && ++contexts === stage) {
        if (network) throw new TypeError('Synthetic network failure');
        return new Response(JSON.stringify(malformed ? {} : { error: { code, message: 'Synthetic failure' } }), {
          status, headers: { 'Content-Type': 'application/json', 'Retry-After': '17' }
        });
      }
      return fetch(url, options);
    },
    polls: () => polls
  };
}
for (const stage of [1, 2, 3, 4]) {
  test(`transient authority read ${stage} withholds pointers then recovers without consuming them`, async t => {
    const f = await fixture(t), fault = failingContext({ stage });
    const client = new AgentWakeClient({ connection: f.connection, fetchImpl: fault.fetch });
    await assert.rejects(client.wait({ hostId: 'retry-host', cadenceSeconds: 60, waitMs: 0 }), error => isTransientWakeError(error));
    assert.equal(fault.polls(), stage < 3 ? 0 : 1);
    assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, f.wake.signalId);
    const recovered = await client.wait({ hostId: 'retry-host', cadenceSeconds: 60, waitMs: 0 });
    assert.deepEqual(recovered.pendingWakes.map(row => row.signalId), [f.wake.signalId]);
    assert.equal(recovered.acknowledged, false);
  });
}
for (const [label, faultOptions, transient] of [
  ['network', { network: true }, true],
  ['rate limit', { status: 429, code: 'rate_limited' }, true],
  ['unauthenticated', { status: 401, code: 'unauthenticated' }, false],
  ['forbidden', { status: 403, code: 'access_denied' }, false],
  ...[400, 404, 409, 422].map(status => [`HTTP ${status}`, { status, code: 'unknown_server_failure' }, false]),
  ['malformed', { status: 200, malformed: true }, false]
]) {
  test(`authority ${label} preserves retry classification`, async t => {
    const f = await fixture(t), fault = failingContext(faultOptions);
    await assert.rejects(new AgentWakeClient({ connection: f.connection, fetchImpl: fault.fetch })
      .wait({ hostId: 'classify', cadenceSeconds: 60, waitMs: 0 }), error => {
        assert.equal(isTransientWakeError(error), transient);
        if (label === 'rate limit') assert.ok(wakeRetryDelayMs(0, error) >= 17000);
        assert.ok(!error.message.includes(f.connection.token));
        return true;
      });
    assert.equal(fault.polls(), 0);
    assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, f.wake.signalId);
  });
}

test('poll retries failed authority read, emits once after recovery, and preserves pending wake', async t => {
  const f = await fixture(t), fault = failingContext();
  const pointers = [], errors = [], pauses = [];
  await listen(['--mode', 'poll', '--host', 'poll-context', '--cadence-seconds', '60'], {
    env: { ROOM_AGENT_CONFIG: f.config }, fetchImpl: fault.fetch, report: error => errors.push(error),
    output: { write(line, done) { pointers.push(JSON.parse(line)); done(); } },
    delay: async ms => { pauses.push(ms); if (pointers.length) process.emit('SIGTERM'); }
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(pauses, [1000, 1000]);
  assert.deepEqual(pointers.map(row => row.signalId), [f.wake.signalId]);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, f.wake.signalId);
});

test('poll stop during transient backoff does not retry or acknowledge', async t => {
  const f = await fixture(t), fault = failingContext();
  const errors = []; let pauses = 0;
  await listen(['--mode', 'poll', '--host', 'stop-context', '--cadence-seconds', '60'], {
    env: { ROOM_AGENT_CONFIG: f.config }, fetchImpl: fault.fetch, report: error => errors.push(error),
    output: { write() { assert.fail('No pointer before fresh authority'); } },
    delay: async (ms, value, { signal }) => { pauses++; process.emit('SIGTERM'); signal.throwIfAborted(); }
  });
  assert.equal(pauses, 1); assert.equal(fault.polls(), 0); assert.deepEqual(errors, []);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, f.wake.signalId);
});

for (const status of [503, 403]) {
  test(`native channel ${status === 503 ? 'recovers' : 'stops'} after authority read failure`, async t => {
    const f = await fixture(t), fault = failingContext({ status, code: status === 403 ? 'access_denied' : 'service_unavailable' });
    const input = new PassThrough(), output = new PassThrough(), frames = [], errors = [];
    let buffer = '';
    const channel = serveClaudeRoomChannel({ connection: f.connection, hostId: 'channel-context', cadenceSeconds: 60,
      input, output, fetchImpl: fault.fetch, report: error => errors.push(error) });
    t.after(() => { channel.stop(); input.destroy(); output.destroy(); });
    output.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame);
        if (frame.id === 1) input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        if (frame.method === 'notifications/claude/channel' && frame.params.meta.signal_id === f.wake.signalId) channel.stop();
      }
    });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'context-retry-peer', version: '1' }
    } }) + '\n');
    const timer = setTimeout(() => { channel.stop(); }, 10000);
    try { await channel.done; } finally { clearTimeout(timer); }
    const delivered = frames.filter(row => row.method === 'notifications/claude/channel' && row.params.meta.signal_id === f.wake.signalId);
    assert.equal(delivered.length, status === 503 ? 1 : 0);
    assert.equal(errors.length, status === 503 ? 0 : 1);
    assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, f.wake.signalId);
  });
}
