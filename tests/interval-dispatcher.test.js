import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { dispatchIntervalOnce } from '../client/interval-dispatcher.mjs';
import { createRoomServer } from '../server/http.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { spawn } from 'node:child_process';

function fixture(t, creator = 'producer', kind = 'interval') {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const directory = mkdtempSync(join(f.directory, 'dispatch-'));
  const identity = { origin: 'http://localhost:9999', roomId: 'commons', memberId: creator };
  const key = f.keys[creator], commands = [];
  const client = {
    async replyRead() { return f.store.automationRead(key, 'commons', 'daily'); },
    async command(command) { commands.push(structuredClone(command)); return f.store.command(key, 'commons', command); }
  };
  const send = (who, type, revision, extra = {}) => f.store.command(f.keys[who], 'commons', { id: `${type}-${revision}`, type: `automation.${type}`, data: { automationId: 'daily', expectedRevision: revision, ...extra } });
  const definition = { title: 'Check', prompt: 'Summarize next action', recipientId: 'guest', trigger: kind === 'manual' ? { kind } : { kind, startAt: '2020-01-01T00:00:00.000Z', intervalMs: 60000 }, maxRuns: 3, maxRuntimeMs: 1000, maxOutputBytes: 1024 };
  send(creator, 'created', 0, { definition }); send(creator, 'enabled', 1); send('guest', 'accepted', 2);
  const options = { directory, client, identity, automationId: 'daily' };
  return { ...f, options, commands, send, definition };
}

test('human and agent creators dispatch one latest interval slot without a process or catch-up burst', async t => {
  for (const creator of ['owner', 'producer']) {
    const f = fixture(t, creator);
    const result = await dispatchIntervalOnce(f.options);
    assert.equal(result.status, 'recorded'); assert.equal(result.processStarted, false);
    const state = f.store.room('commons').state;
    assert.equal(state.automations.daily.dispatchCount, 1);
    assert.ok(state.automations.daily.lastSlot > 100);
    assert.equal(state.replyRequests[result.requestMessageId].status, 'open');
    assert.equal((await dispatchIntervalOnce(f.options)).status, 'idle');
    assert.equal(f.commands.length, 1);
  }
});

test('lost dispatch receipt survives a new invocation and retries exact scope even after pause', async t => {
  const f = fixture(t), original = f.options.client.command;
  f.options.client.command = async command => { await original(command); throw new Error('lost receipt'); };
  const first = await dispatchIntervalOnce(f.options); assert.equal(first.status, 'unconfirmed');
  f.send('producer', 'paused', 4);
  f.options.client.command = original;
  const recovered = await dispatchIntervalOnce({ ...f.options });
  assert.equal(recovered.status, 'recorded'); assert.equal(recovered.duplicate, true);
  assert.deepEqual(f.commands[0], f.commands[1]);
  assert.equal(f.store.room('commons').state.automations.daily.dispatchCount, 1);
});

test('concurrent journal users and separate journals converge on one dispatch', async t => {
  const f = fixture(t), directory = mkdtempSync(join(f.directory, 'other-'));
  const results = await Promise.all([dispatchIntervalOnce(f.options), dispatchIntervalOnce(f.options), dispatchIntervalOnce({ ...f.options, directory })]);
  assert.ok(results.some(r => r.status === 'recorded'));
  assert.equal(f.store.room('commons').state.automations.daily.dispatchCount, 1);
  assert.equal(new Set(f.commands.map(c => c.id)).size, 1);
});

test('manual definitions never dispatch and journals cannot switch identity', async t => {
  const f = fixture(t, 'producer', 'manual');
  assert.deepEqual(await dispatchIntervalOnce(f.options), { status: 'idle', reason: 'manual', processStarted: false });
  assert.equal(f.commands.length, 0);
  await assert.rejects(dispatchIntervalOnce({ ...f.options, identity: { ...f.options.identity, memberId: 'owner' } }), /identity_changed/);
});

test('revocation after an uncertain non-write cannot create a request on retry', async t => {
  const f = fixture(t), original = f.options.client.command;
  f.options.client.command = async () => { throw new Error('offline'); };
  assert.equal((await dispatchIntervalOnce(f.options)).status, 'unconfirmed');
  f.store.revoke(f.keys.producer); f.options.client.command = original;
  assert.equal((await dispatchIntervalOnce(f.options)).status, 'unconfirmed');
  assert.equal(f.store.room('commons').state.automations.daily.dispatchCount, 0);
});

test('one-shot CLI dispatches through authenticated HTTP without starting a timer', async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const connectionDirectory = join(f.directory, 'connection');
  saveAgentConnection(connectionDirectory, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/room-interval.mjs', '--once', connectionDirectory, f.options.directory, 'daily'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).status, 'recorded');
  assert.equal(JSON.parse(result.out).processStarted, false);
  assert.equal(f.store.room('commons').state.automations.daily.dispatchCount, 1);
});
