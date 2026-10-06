// Owner: scripts/room-listen.mjs. Channel delivery stays in tests/claude-channel.test.js.
// These cases cover the mode switch, stdout pointers, the webhook call that
// does not listen, and the qualification child that records a real reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomStore } from '../server/store.mjs';

const roomListen = fileURLToPath(new URL('../scripts/room-listen.mjs', import.meta.url));
const pluginServe = fileURLToPath(new URL('../plugins/project-room/channel/serve.mjs', import.meta.url));
const qualify = fileURLToPath(new URL('../scripts/receive-qualify.mjs', import.meta.url));

async function saved(t, { listen = false } = {}) {
  const store = new RoomStore(':memory:');
  const owner = store.identities.create('Listen owner');
  const agent = store.identities.create('Listen receiver');
  const server = listen ? createRoomServer({ store }) : null;
  if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'room-listen-'));
  const config = join(directory, 'private');
  const origin = server ? 'http://127.0.0.1:' + server.address().port : 'http://127.0.0.1:9';
  if (listen) {
    new AgentRooms(store).create(owner.secret, { roomId: 'listen-room', title: 'Listen', purpose: 'Synthetic poll' });
    store.identities.link(owner.secret, 'listen-room', { identityId: agent.identityId, memberId: 'receiver', displayName: 'Receiver', permissions: [] });
  }
  saveAgentConnection(config, { version: 1, origin, roomId: 'listen-room', memberId: 'receiver', token: agent.secret });
  const requests = [];
  if (server) server.on('request', request => requests.push(request.url));
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, agent, config, requests, server };
}

function run(t, script, args, env) {
  // These tests parse the child's stderr as JSON, so a Node runtime warning
  // (e.g. NO_COLOR ignored because FORCE_COLOR is set) must not land there.
  const child = spawn(process.execPath, [script, ...args], { env: { ...env, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
  return { child, text: () => ({ stdout, stderr }) };
}

test('poll prints one pointer and leaves the wake pending; webhook prints the subscribe call and does not connect', async t => {
  const f = await saved(t, { listen: true });
  const signal = f.store.agentHeartbeats.enqueueWake({ agentId: f.agent.identityId, kind: 'mention', roomId: 'listen-room', messageId: 'poll-message' }).signal;
  const env = { ...process.env, ROOM_AGENT_CONFIG: f.config };
  for (const name of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete env[name];
  const poll = run(t, roomListen, ['--mode', 'poll', '--host', 'poll-host', '--cadence-seconds', '60'], env);
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Poll pointer not printed')), 15000);
    poll.child.stdout.on('data', () => {
      const row = poll.text().stdout.split('\n').find(item => item.includes(signal.signalId));
      if (!row) return;
      clearTimeout(timer);
      resolve(JSON.parse(row));
    });
  });
  assert.equal(line.signalId, signal.signalId);
  assert.equal(line.messageId, 'poll-message');
  assert.equal(line.roomId, 'listen-room');
  assert.equal(Object.hasOwn(line, 'body'), false);
  await new Promise((resolve, reject) => {
    let polls = 0;
    const timer = setTimeout(() => reject(new Error('Repeated wake polls not observed')), 15000);
    const listener = (request, response) => {
      if (!request.url.includes('/agent-wakes/poll')) return;
      response.once('finish', () => { if (++polls >= 2) { clearTimeout(timer); f.server.off('request', listener); resolve(); } });
    };
    f.server.on('request', listener);
  });
  assert.equal(poll.text().stdout.split('\n').filter(item => item.includes(signal.signalId)).length, 1);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, signal.signalId);
  poll.child.kill('SIGTERM');
  assert.equal((await once(poll.child, 'exit'))[0], 0);
  const before = f.requests.length;
  const hook = run(t, roomListen, ['--mode', 'webhook', '--host', 'hook-host', '--cadence-seconds', '60', '--webhook-url', 'https://events.example/room'], env);
  const [code] = await once(hook.child, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(hook.text().stdout), {
    jsonrpc: '2.0', method: 'tools/call',
    params: { name: 'webhook_subscribe', arguments: { url: 'https://events.example/room', events: ['agent.wake'] } }
  });
  assert.equal(f.requests.length, before);
  assert.equal(hook.text().stderr.includes(f.agent.secret), false);
  assert.equal(hook.text().stdout.includes(f.agent.secret), false);
});

test('webhook refuses a url that contains the saved credential without echoing it', async t => {
  const f = await saved(t);
  const env = { ...process.env, ROOM_AGENT_CONFIG: f.config };
  const url = 'https://events.example/hook?token=' + f.agent.secret;
  const child = run(t, roomListen, ['--mode', 'webhook', '--host', 'hook-host', '--cadence-seconds', '60', '--webhook-url', url], env);
  const [code] = await once(child.child, 'exit');
  assert.equal(code, 1);
  const output = child.text().stdout + child.text().stderr;
  assert.equal(output.includes(f.agent.secret), false);
  assert.equal(output.includes('events.example'), false);
  assert.equal(JSON.parse(child.text().stderr).code, 'invalid_config');
});

test('usage and plugin directory prompt stay free of the credential', async t => {
  const f = await saved(t);
  const env = { ...process.env, ROOM_AGENT_TOKEN: f.agent.secret };
  delete env.ROOM_AGENT_CONFIG;
  const usage = run(t, roomListen, ['--mode', 'poll', '--host', 'poll-host', '--cadence-seconds', '60'], env);
  assert.equal((await once(usage.child, 'exit'))[0], 1);
  assert.equal((usage.text().stdout + usage.text().stderr).includes(f.agent.secret), false);
  assert.equal(JSON.parse(usage.text().stderr).code, 'usage_error');
  const prompted = { ...process.env, CLAUDE_PLUGIN_OPTION_ROOM_AGENT_CONFIG: f.config };
  delete prompted.ROOM_AGENT_CONFIG;
  for (const name of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete prompted[name];
  const plugin = run(t, pluginServe, ['--mode', 'webhook', '--host', 'hook-host', '--cadence-seconds', '60', '--webhook-url', 'https://events.example/room'], prompted);
  assert.equal((await once(plugin.child, 'exit'))[0], 0);
  assert.equal(JSON.parse(plugin.text().stdout).params.name, 'webhook_subscribe');
  assert.equal(plugin.text().stdout.includes(f.agent.secret), false);
});

test('qualification child records the reply and returns reachability evidence', async t => {
  const child = spawn(process.execPath, [qualify], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    qualified: true, replyStatus: 'answered', signalAcknowledged: true, reachabilityObserved: true, uiBadge: 'room_ui_v2'
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
});
