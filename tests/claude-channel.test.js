// Primary contract: actual child stdio channel -> real HTTP Room -> durable queue.
// Credible regressions: pre-init polling, notification-as-ACK, replay loss, or
// stale authorization emission. Existing wake tests do not reach this native
// channel transport. No test-only production seams or provider model are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'), owner = store.identities.create('Channel owner'), agent = store.identities.create('Channel receiver');
  new AgentRooms(store).create(owner.secret, { roomId: 'channel-room', title: 'Channel', purpose: 'Synthetic transport qualification' });
  store.identities.link(owner.secret, 'channel-room', { identityId: agent.identityId, memberId: 'receiver', displayName: 'Receiver', permissions: [] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'claude-channel-')), config = join(directory, 'private');
  saveAgentConnection(config, { version: 1, origin: 'http://127.0.0.1:' + server.address().port,
    roomId: 'channel-room', memberId: 'receiver', token: agent.secret });
  const children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const enqueue = messageId => store.agentHeartbeats.enqueueWake({ agentId: agent.identityId,
    kind: 'mention', roomId: 'channel-room', messageId }).signal;
  return { store, server, owner, agent, config, enqueue, children };
}
function peer(t, f, ordinary = false) {
  const env = { ...process.env, ROOM_AGENT_CONFIG: f.config };
  for (const name of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete env[name];
  const child = spawn(process.execPath, [fileURLToPath(new URL(ordinary ? '../scripts/agent-mcp.mjs' : '../scripts/agent-claude-channel.mjs', import.meta.url)),
    ...(ordinary ? [] : ['--host', 'channel-test', '--cadence-seconds', '60'])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  f.children.push(child);
  const frames = [], waiters = new Set(); let buffer = '', stderr = '', id = 0;
  const exit = once(child, 'exit');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame);
      for (const waiter of [...waiters]) if (waiter.match(frame)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(frame); }
    }
  });
  const wait = match => {
    const prior = frames.find(match); if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('Expected channel frame not received')); }, 15000) };
      waiters.add(waiter);
    });
  };
  const send = frame => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const rpc = (method, params = {}) => { const requestId = ++id; send({ id: requestId, method, params }); return wait(frame => frame.id === requestId); };
  const initialize = () => rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-channel-peer', version: '1' } });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); return exit; };
  t.after(async () => {
    await stop(); for (const waiter of waiters) clearTimeout(waiter.timer);
    assert.ok(!stderr.includes(f.agent.secret) && !JSON.stringify(frames).includes(f.agent.secret), 'No saved credential in channel output');
  });
  return { frames, child, exit, send, rpc, initialize, stop, wait, stderr: () => stderr };
}
const signalFrame = signal => frame => frame.method === 'notifications/claude/channel' && frame.params.meta.signal_id === signal.signalId;

test('real channel starts after initialization, delivers once, and requires explicit scoped ACK; generic MCP stays tools-only', async t => {
  const f = await fixture(t), signal = f.enqueue('private-message');
  new AgentRooms(f.store).create(f.owner.secret, { roomId: 'other-room', title: 'Other', purpose: 'Other private scope' });
  f.store.identities.link(f.owner.secret, 'other-room', { identityId: f.agent.identityId, memberId: 'other-receiver', displayName: 'Other', permissions: [] });
  const foreign = f.store.agentHeartbeats.enqueueWake({ agentId: f.agent.identityId, kind: 'mention', roomId: 'other-room', messageId: 'foreign-private-message' }).signal;
  const p = peer(t, f);
  const initialized = await p.initialize();
  assert.deepEqual(initialized.result.capabilities.experimental, { 'claude/channel': {} });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_hosts').get().n, 0);
  p.send({ method: 'notifications/initialized' });
  const notice = await p.wait(signalFrame(signal));
  assert.match(notice.params.content, /private-message/);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId).length, 2, 'notification does not consume wake');
  // A third real poll proves the second cycle finished, independently of the
  // adapter's internal set. Retained unacknowledged hints must not flood stdio.
  await new Promise((resolve, reject) => {
    let polls = 0; const timer = setTimeout(() => reject(new Error('Repeated HTTP polls not observed')), 15000);
    const listener = (request, response) => {
      if (!request.url.includes('/agent-wakes/poll')) return;
      response.once('finish', () => { if (++polls >= 2) { clearTimeout(timer); f.server.off('request', listener); resolve(); } });
    };
    f.server.on('request', listener);
  });
  assert.equal(p.frames.filter(signalFrame(signal)).length, 1);
  assert.equal(p.frames.filter(signalFrame(foreign)).length, 0);
  assert.ok(!JSON.stringify(p.frames).includes('foreign-private-message'));
  const denied = await p.rpc('tools/call', { name: 'room_acknowledge_wake', arguments: { signalIds: [foreign.signalId] } });
  assert.equal(denied.result.isError, true);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId).length, 2);
  const ack = await p.rpc('tools/call', { name: 'room_acknowledge_wake', arguments: { signalIds: [signal.signalId] } });
  assert.deepEqual(ack.result.structuredContent.acknowledged, [signal.signalId]);
  assert.equal(ack.result.structuredContent.reachability.observed, false);
  assert.equal(ack.result.structuredContent.reachability.basis, 'ack_without_linked_reply');
  assert.equal(ack.result.structuredContent.reachability.uiBadge, 'room_ui_v2');
  assert.deepEqual(f.store.agentHeartbeats.pendingWakes(f.agent.identityId).map(row => row.signalId), [foreign.signalId]);
  assert.equal((await p.stop())[0], 0, 'shutdown cancels held fetch');
  const ordinary = peer(t, f, true), result = await ordinary.initialize();
  assert.equal(result.result.capabilities.experimental, undefined);
  ordinary.send({ method: 'notifications/initialized' });
  const tools = await ordinary.rpc('tools/list');
  assert.ok(!tools.result.tools.some(tool => tool.name === 'room_acknowledge_wake'));
});

test('restarting the actual channel child redelivers the same unacknowledged signal', async t => {
  const f = await fixture(t), signal = f.enqueue('restart-message'), first = peer(t, f);
  await first.initialize(); first.send({ method: 'notifications/initialized' }); await first.wait(signalFrame(signal));
  assert.equal((await first.stop())[0], 0);
  const second = peer(t, f); await second.initialize(); second.send({ method: 'notifications/initialized' });
  await second.wait(signalFrame(signal));
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, signal.signalId);
});

test('revocation after HTTP poll and before final authorization emits no signal and leaves queue pending', async t => {
  const f = await fixture(t), signal = f.enqueue('revoked-message');
  f.server.on('request', (request, response) => {
    if (request.url.includes('/agent-wakes/poll')) response.once('finish', () => f.store.identities.unlink(f.owner.secret, 'channel-room', f.agent.identityId));
  });
  const p = peer(t, f); await p.initialize(); p.send({ method: 'notifications/initialized' });
  assert.equal((await p.exit)[0], 1);
  assert.equal(p.frames.filter(signalFrame(signal)).length, 0);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, signal.signalId);
});

test('committed ACK with lost HTTP response is unconfirmed; exact retry does not invent confirmation', async t => {
  const f = await fixture(t), signal = f.enqueue('lost-ack'), p = peer(t, f);
  await p.initialize(); p.send({ method: 'notifications/initialized' }); await p.wait(signalFrame(signal));
  let dropped = false;
  f.server.on('request', (request, response) => {
    if (request.url.endsWith('/agent-heartbeats/ack') && !dropped) { dropped = true; response.end = () => { response.destroy(); }; }
  });
  const args = { name: 'room_acknowledge_wake', arguments: { signalIds: [signal.signalId] } };
  const lost = await p.rpc('tools/call', args);
  assert.equal(lost.result.isError, true);
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId).length, 0);
  const retry = await p.rpc('tools/call', args);
  assert.deepEqual(retry.result.structuredContent.acknowledged, []);
  assert.deepEqual(retry.result.structuredContent.notAcknowledged, [signal.signalId]);
});

test('startup surfaces historical addressed attention immediately even when the wake queue is empty', async t => {
  const f = await fixture(t);
  f.store.dmConsents.request('channel-room', f.owner.identityId, 'receiver', 'Synthetic request');
  f.store.dmConsents.decide('channel-room', 'receiver', f.owner.identityId, 'approve');
  const key = f.store.issueAccessKey('channel-room', f.owner.identityId);
  f.store.command(key, 'channel-room', { id: 'historical-question', type: 'message.posted', data: {
    messageId: 'historical-question', body: 'Synthetic private question', toMemberId: 'receiver', requestKind: 'reply' } });
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId).length, 0);
  const p = peer(t, f); await p.initialize(); p.send({ method: 'notifications/initialized' });
  const notice = await p.wait(frame => frame.method === 'notifications/claude/channel' && frame.params.meta.notice_kind === 'startup_attention');
  assert.ok(!notice.params.content.includes('Synthetic private question'), 'startup publishes no private message body');
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId).length, 0);
});

test('broken child stdout stops delivery without acknowledging the wake', async t => {
  const f = await fixture(t), signal = f.enqueue('broken-output'), p = peer(t, f);
  await p.initialize(); p.child.stdout.destroy(); p.send({ method: 'notifications/initialized' });
  await p.exit;
  assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId)[0].signalId, signal.signalId);
});
