import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { AgentWakeClient } from '../client/agent-wake.mjs';

// Fixture-only setup/revocation/state. Every adapter read/register/poll/ACK
// traverses the real production Worker entry and authenticated HTTP routes.
const fixture = `
import entry, { ProjectRoom } from './room.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
export class WakeTestRoom extends ProjectRoom {
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/__fixture/setup') {
   const owner = this.store.identities.create('Synthetic wake owner');
   new AgentRooms(this.store).create(owner.secret,{roomId:'wake-room',title:'Wake test',purpose:'Disposable Worker adapter'});
   const identity = this.store.identities.create('Synthetic listener');
   this.store.identities.link(owner.secret,'wake-room',{identityId:identity.identityId,memberId:'linked-worker',displayName:'Listener',permissions:[]});
   return Response.json({identity,ownerSecret:owner.secret,roomKey:this.store.issueAccessKey('wake-room','linked-worker')});
  }
  if (path === '/__fixture/state') return Response.json({hosts:this.store.db.prepare('SELECT count(*) n FROM agent_hosts').get().n,
   signals:this.store.db.prepare('SELECT signal_id,delivered_at FROM agent_wake_signals').all(),
   identityLinks:this.store.db.prepare('SELECT count(*) n FROM identity_links').get().n,
   credits:this.store.db.prepare('SELECT count(*) n FROM bounty_journal').get().n});
  if (path === '/__fixture/revoke') {
   const input = await request.json();
   this.store.identities.revoke(input.identityId,input.identitySecret);
   return Response.json({revoked:true});
  }
  return super.fetch(request);
 }
}
export default entry;
`;
test('actual Worker wake setup/poll survives disposal, ordinary mention releases listener, explicit ACK and revoked scope fail closed', { timeout: 60000 }, async () => {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'wake-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'agent-wake-worker-'));
  const origin = 'https://room.example.test';
  const config = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'WakeTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin }, durableObjectsPersist: persistence };
  let worker = new Miniflare(config);
  const fetchImpl = (url, options) => worker.dispatchFetch(url, options);
  const api = (path, body, token) => fetchImpl(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
  try {
    const { identity, ownerSecret, roomKey } = await json(await api('/__fixture/setup', {}));
    const connection = { origin, roomId: 'wake-room', memberId: 'linked-worker', token: identity.secret };
    const client = new AgentWakeClient({ connection, fetchImpl });
    const before = await json(await api('/__fixture/state'));
    assert.equal((await client.doctor({ hostId: 'worker-host' })).registration, 'not_registered');
    assert.equal((await json(await api('/__fixture/state'))).hosts, 0);
    assert.throws(() => new AgentWakeClient({ connection: { ...connection, token: roomKey }, fetchImpl }));
    assert.equal((await api('/api/agent-heartbeats', {hostId:'room-key-refused',mode:'wakeable'}, roomKey)).status, 403);
    await assert.rejects(new AgentWakeClient({connection:{...connection,token:'pri_'+'X'.repeat(43)},fetchImpl}).doctor({hostId:'worker-host'}),error=>error.status===401);
    const setup = await client.setup({ hostId: 'worker-host', cadenceSeconds: 300 });
    assert.equal(setup.status, 'registered_not_listening');
    assert.deepEqual((await client.wait({ hostId: 'worker-host', cadenceSeconds: 300, waitMs: 0 })).pendingWakes, []);
    let pollReady;
    const ready = new Promise(resolve => { pollReady = resolve; });
    const listener = new AgentWakeClient({ connection, fetchImpl: (url, options) => {
      const result = fetchImpl(url, options);
      if (String(url).includes('/agent-wakes/poll')) pollReady();
      return result;
    } });
    const held = listener.wait({ hostId: 'worker-host', cadenceSeconds: 300, waitMs: 2000 });
    await ready;
    // Wait for the real poll request to enter the Durable Object, not a mocked queue.
    await new Promise(resolve => setTimeout(resolve, 100));
    await json(await api('/api/rooms/wake-room/commands', { id: 'mention-wake', type: 'message.posted',
      data: { messageId: 'mention-wake', body: 'Please respond @linked-worker' } }, ownerSecret), 201);
    const signal = await held;
    assert.equal(signal.pendingWakes.length, 1); assert.equal(signal.acknowledged, false);
    assert.equal(signal.pendingWakes[0].messageId, 'mention-wake');
    await worker.dispose(); worker = new Miniflare(config);
    const reopened = await client.wait({ hostId: 'worker-host', cadenceSeconds: 300, waitMs: 0 });
    assert.deepEqual(reopened.pendingWakes, signal.pendingWakes);
    assert.deepEqual((await client.ack({ signalIds: ['unknown'] })).notAcknowledged, ['unknown']);
    assert.deepEqual((await client.ack({ signalIds: [signal.pendingWakes[0].signalId] })).acknowledged, [signal.pendingWakes[0].signalId]);
    assert.deepEqual((await client.wait({ hostId: 'worker-host', cadenceSeconds: 300, waitMs: 0 })).pendingWakes, []);
    assert.ok(!JSON.stringify(reopened).includes(identity.secret));
    await json(await api('/__fixture/revoke', { identitySecret: identity.secret, identityId: identity.identityId }));
    await assert.rejects(client.setup({ hostId: 'worker-host', cadenceSeconds: 300 }));
    const after = await json(await api('/__fixture/state'));
    assert.equal(after.credits, before.credits); assert.equal(after.identityLinks, before.identityLinks);
    assert.equal(after.signals.length, 1); assert.notEqual(after.signals[0].delivered_at, null);
  } finally { await worker.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
