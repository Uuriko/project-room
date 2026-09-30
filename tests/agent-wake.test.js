// Actual loopback adapter journeys: registration is not listening; hints never
// consume work; ambiguous acknowledgment cannot be reported as success.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { main } from '../scripts/agent-wake.mjs';
async function fixture(t) {
  const store = new RoomStore(':memory:'); const identity = store.identities.create('Wake owner');
  new AgentRooms(store).create(identity.secret, { roomId: 'wake-room', title: 'Wake', purpose: 'Synthetic wake testing' });
  const alias = store.identities.create('Linked alias');
  store.identities.link(identity.secret, 'wake-room', { identityId: alias.identityId, memberId: 'linked-alias', displayName: 'Alias', permissions: [] });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const connection = { origin: 'http://127.0.0.1:' + server.address().port, roomId: 'wake-room', memberId: 'linked-alias', token: alias.secret };
  return { store, owner: identity, identity: alias, connection, client: new AgentWakeClient({ connection }) };
}
test('doctor is read-only and setup without URL registers a custom-linked identity without claiming a listener', async t => {
  const { store, client } = await fixture(t);
  assert.equal((await client.doctor({ hostId: 'laptop' })).registration, 'not_registered');
  assert.equal(store.db.prepare('SELECT count(*) n FROM agent_hosts').get().n, 0);
  const registered = await client.setup({ hostId: 'laptop', cadenceSeconds: 300 });
  assert.equal(registered.status, 'registered_not_listening');
  assert.equal((await client.doctor({ hostId: 'laptop' })).listening, 'not_observed');
  assert.equal(store.db.prepare('SELECT wake_url FROM agent_hosts').get().wake_url, null);
});
test('wait returns current read observations even with empty hints and never acknowledges queued hints', async t => {
  const { store, owner, client, identity, connection } = await fixture(t);
  await client.setup({ hostId: 'laptop', cadenceSeconds: 60 });
  // Another host may have acknowledged a hint without completing this observer’s attention read.
  store.command(owner.secret, 'wake-room', { id: 'gap-command', type: 'message.posted', data: { messageId: 'gap-message', body: 'Please respond @linked-alias' } });
  const earlierHints = store.agentHeartbeats.pendingWakes(identity.identityId);
  if (earlierHints.length) store.agentHeartbeats.ackWakes({ agentId: identity.identityId, signalIds: earlierHints.map(row => row.signalId) });
  assert.equal(store.agentHeartbeats.pendingWakes(identity.identityId).length, 0);
  const empty = await client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0 });
  assert.deepEqual(empty.pendingWakes, []); assert.equal(empty.acknowledged, false);
  assert.ok([...empty.observations.before.attention, ...empty.observations.after.attention].some(row => row.id === 'gap-message'));
  assert.equal(empty.observations.after.connection.status, 'credential_accepted');
  const wake = store.agentHeartbeats.enqueueWake({ agentId: identity.identityId, kind: 'mention', roomId: 'wake-room', messageId: 'wake-message' }).signal;
  const queued = await client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0 });
  assert.equal(queued.pendingWakes[0].signalId, wake.signalId);
  assert.equal(store.agentHeartbeats.pendingWakes(identity.identityId).length, 1);
  assert.ok(!JSON.stringify(queued).includes(connection.token)); assert.equal(JSON.stringify(client), '{}');
  const ack = await client.ack({ signalIds: [wake.signalId, 'unknown'] });
  assert.deepEqual(ack.acknowledged, [wake.signalId]); assert.deepEqual(ack.notAcknowledged, ['unknown']);
  assert.deepEqual((await client.ack({ signalIds: [wake.signalId] })).notAcknowledged, [wake.signalId]);
});
test('lost wait output leaves signals queued; ambiguous ack is unconfirmed and explicit retry reports authoritative state', async t => {
  const { store, connection, identity } = await fixture(t);
  const wake = store.agentHeartbeats.enqueueWake({ agentId: identity.identityId, kind: 'mention', roomId: 'wake-room', messageId: 'lost-message' }).signal;
  const client = new AgentWakeClient({ connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/ack')) throw new Error('Lost response ' + connection.token);
    return response;
  } });
  await client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0 });
  assert.equal(store.agentHeartbeats.pendingWakes(identity.identityId).length, 1);
  await assert.rejects(client.ack({ signalIds: [wake.signalId] }), error => error.code === 'service_unavailable' && !error.message.includes(connection.token));
  const retry = await new AgentWakeClient({ connection }).ack({ signalIds: [wake.signalId] });
  assert.deepEqual(retry.acknowledged, []); assert.deepEqual(retry.notAcknowledged, [wake.signalId]);
});
test('adapter refuses Room keys, mismatched configured members and invalid commands without leaking credentials', async t => {
  const { connection, store } = await fixture(t);
  assert.throws(() => new AgentWakeClient({ connection: { ...connection, token: store.issueAccessKey('wake-room', 'linked-alias') } }));
  await assert.rejects(new AgentWakeClient({ connection: { ...connection, token: 'pri_' + 'X'.repeat(43) } }).doctor({ hostId: 'laptop' }), error => error.status === 401);
  await assert.rejects(new AgentWakeClient({ connection: { ...connection, memberId: 'missing' } }).setup({ hostId: 'laptop', cadenceSeconds: 60 }));
  const out = []; let calls = 0;
  assert.equal(await main(['wait', '--host', 'laptop'], { write: value => out.push(value), fetchImpl: () => { calls++; } }), 1);
  assert.equal(calls, 0); assert.ok(!out.join('').includes(connection.token));
});

test('revocation between poll and final fresh check discards signals and leaves them unacknowledged', async t => {
  const { store, owner, identity, connection } = await fixture(t);
  const wake = store.agentHeartbeats.enqueueWake({ agentId: identity.identityId, kind: 'mention', roomId: 'wake-room', messageId: 'revoked-message' }).signal;
  const client = new AgentWakeClient({ connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).includes('/agent-wakes/poll')) store.identities.unlink(owner.secret, 'wake-room', identity.identityId);
    return response;
  } });
  await assert.rejects(client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0 }));
  assert.equal(store.agentHeartbeats.pendingWakes(identity.identityId)[0].signalId, wake.signalId);
});
test('invalid observation cursors refuse before any network and transport response secrets are never output', async t => {
  const { connection } = await fixture(t); let calls = 0;
  const client = new AgentWakeClient({ connection, fetchImpl: async () => { calls++; throw new Error(connection.token); } });
  await assert.rejects(client.wait({ hostId: 'laptop', cadenceSeconds: 60, waitMs: 0, attentionCursor: { rooms: {}, handled: true } }));
  assert.equal(calls, 0);
  const out = [];
  const env = { ROOM_AGENT_ORIGIN: connection.origin, ROOM_AGENT_ROOM: connection.roomId, ROOM_AGENT_MEMBER: connection.memberId, ROOM_AGENT_TOKEN: connection.token };
  assert.equal(await main(['doctor', '--host', 'laptop'], { env, write: value => out.push(value), fetchImpl: async () => { throw new Error(connection.token); } }), 1);
  assert.ok(!out.join('').includes(connection.token));
});

test('actual CLI saved connection survives server restart; unknown ACK and lost committed ACK remain truthful and private', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wake-cli-')); const file = join(directory, 'room.sqlite');
  let store = new RoomStore(file); const identity = store.identities.create('Restarting CLI');
  new AgentRooms(store).create(identity.secret, { roomId: 'restart', title: 'Restart', purpose: 'Synthetic saved CLI' });
  let server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = join(directory, 'connection');
  saveAgentConnection(config, {version:1,origin:'http://127.0.0.1:'+port,roomId:'restart',memberId:identity.identityId,token:identity.secret});
  const env = { ROOM_AGENT_CONFIG: config }; const out = [];
  // Each ordinary command is an actual CLI process. An in-process main()
  // harness retains its fetch pool after rebinding the same port;
  // a real newly invoked CLI has no socket from the stopped server.
  const childEnv = { ...process.env, ...env };
  for (const name of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete childEnv[name];
  const run = async (args, fetchImpl) => {
    if (fetchImpl) return main(args, {env,fetchImpl,write:value=>out.push(JSON.parse(value))});
    const reply = await new Promise(resolve => execFile(process.execPath,
      [fileURLToPath(new URL('../scripts/agent-wake.mjs', import.meta.url)), ...args],
      { env: childEnv, timeout: 30000, maxBuffer: 1048576 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.ok(!reply.stdout.includes(identity.secret) && !reply.stderr.includes(identity.secret), 'CLI output must exclude the saved credential');
    if (reply.error && !Number.isInteger(reply.error.code)) throw new Error('CLI process did not complete');
    out.push(JSON.parse(reply.stdout.trim()));
    return reply.error?.code ?? 0;
  };
  const diagnostic = () => {
    const result = out.at(-1);
    return JSON.stringify({ code: result?.code, status: result?.status,
      incomplete: ['before', 'after'].flatMap(stage => (result?.observations?.[stage]?.incompleteSources ?? [])
        .slice(0, 5).map(row => ({ stage, source: row.source, code: row.code }))) });
  };
  try {
    assert.equal(await run(['setup','--host','cli','--cadence-seconds','300']),0);
    assert.equal(out.at(-1).status,'registered_not_listening');
    const wake = store.agentHeartbeats.enqueueWake({agentId:identity.identityId,kind:'mention',roomId:'restart',messageId:'restart-message'}).signal;
    await new Promise(resolve=>server.close(resolve)); store.close();
    store = new RoomStore(file); server = createRoomServer({store}); await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
    const waitExit = await run(['wait','--host','cli','--cadence-seconds','300','--wait-ms','0']);
    assert.equal(waitExit,0,diagnostic());
    assert.equal(out.at(-1).pendingWakes[0].signalId,wake.signalId);
    assert.equal(await run(['ack','--host','cli','--signal','unknown']),0);
    assert.deepEqual(out.at(-1).notAcknowledged,['unknown']);
    assert.equal(await run(['ack','--host','cli','--signal',wake.signalId],async(url,options)=>{
      const response=await fetch(url,options); if(String(url).endsWith('/ack')) throw new Error(identity.secret); return response;
    }),1);
    assert.equal(out.at(-1).code,'service_unavailable');
    assert.equal(await run(['ack','--host','cli','--signal',wake.signalId]),0);
    assert.deepEqual(out.at(-1).notAcknowledged,[wake.signalId]);
    assert.ok(!JSON.stringify(out).includes(identity.secret));
  } finally { await new Promise(resolve=>server.close(resolve)); store.close(); rmSync(directory,{recursive:true,force:true}); }
});
