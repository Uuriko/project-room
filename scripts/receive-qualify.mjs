// Drives one complete exchange against a throwaway local Room:
// directed request, pointer, Room-tool reply, wake ack, stored answer.
// Starts no model. Prints one receipt. The token stays in the private directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomStore } from '../server/store.mjs';

const roomId = 'qualify-room';
const messageId = 'qualify-question';

async function qualify() {
  const store = new RoomStore(':memory:');
  const owner = store.identities.create('Qualify owner');
  const agent = store.identities.create('Qualify receiver');
  new AgentRooms(store).create(owner.secret, { roomId, title: 'Qualify', purpose: 'Synthetic receive qualification' });
  store.identities.link(owner.secret, roomId, { identityId: agent.identityId, memberId: 'receiver', displayName: 'Receiver', permissions: [] });
  store.dmConsents.request(roomId, owner.identityId, 'receiver', 'Synthetic request');
  store.dmConsents.decide(roomId, 'receiver', owner.identityId, 'approve');
  store.dmConsents.request(roomId, 'receiver', owner.identityId, 'Synthetic reply');
  store.dmConsents.decide(roomId, owner.identityId, 'receiver', 'approve');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'receive-qualify-'));
  const config = join(directory, 'private');
  saveAgentConnection(config, {
    version: 1, origin: 'http://127.0.0.1:' + server.address().port,
    roomId, memberId: 'receiver', token: agent.secret
  });
  const env = { ...process.env, ROOM_AGENT_CONFIG: config };
  for (const name of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete env[name];
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./room-listen.mjs', import.meta.url)),
    '--mode', 'channel', '--host', 'qualify-host', '--cadence-seconds', '60'
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', buffer = '', id = 0;
  const frames = [], waiters = new Set();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      frames.push(frame);
      for (const waiter of [...waiters]) if (waiter.match(frame)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(frame); }
    }
  });
  const wait = match => {
    const prior = frames.find(match);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('Expected qualification frame not received')); }, 20000) };
      waiters.add(waiter);
    });
  };
  const send = frame => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const rpc = (method, params = {}) => { const requestId = ++id; send({ id: requestId, method, params }); return wait(frame => frame.id === requestId); };
  const secret = agent.secret;
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'receive-qualify', version: '1' } });
    assert.deepEqual(initialized.result.capabilities.experimental, { 'claude/channel': {} });
    send({ method: 'notifications/initialized' });
    const deadline = Date.now() + 10000;
    while (store.agentHeartbeats.statusOf(agent.identityId).status !== 'online') {
      if (Date.now() > deadline) throw new Error('Receiving host did not register');
      await delay(50);
    }
    const key = store.issueAccessKey(roomId, owner.identityId);
    store.command(key, roomId, { id: 'qualify-ask', type: 'message.posted', data: {
      messageId, body: 'Which file should change?', toMemberId: 'receiver', requestKind: 'reply' } });
    const notice = await wait(frame => frame.method === 'notifications/claude/channel' && frame.params?.meta?.signal_id);
    const pointerLine = notice.params.content.split('\n')[0];
    const pointer = JSON.parse(pointerLine.slice(pointerLine.indexOf('{')));
    assert.equal(pointer.messageId, messageId);
    assert.equal(notice.params.content.includes('Which file should change?'), false);
    const read = await rpc('tools/call', { name: 'room_read_request', arguments: { requestMessageId: messageId } });
    assert.equal(read.result.isError, undefined);
    const context = read.result.structuredContent;
    const answer = {
      requestId: 'qualify-answer', responseToRequestId: context.request.id,
      ...context.current.answerBasis, responseOutcome: 'answered',
      toMemberId: context.request.requesterId, workItemId: context.request.workItemId,
      body: 'Change the listener and record the reply.'
    };
    const posted = await rpc('tools/call', { name: 'room_respond_to_request', arguments: answer });
    assert.equal(posted.result.structuredContent.status, 'recorded');
    assert.equal(store.room(roomId).state.replyRequests[messageId].status, 'answered');
    const ack = await rpc('tools/call', { name: 'room_acknowledge_wake', arguments: { signalIds: [pointer.signalId] } });
    assert.deepEqual(ack.result.structuredContent.acknowledged, [pointer.signalId]);
    assert.equal(ack.result.structuredContent.reachability.observed, true);
    assert.equal(ack.result.structuredContent.reachability.basis, 'reply_then_ack');
    assert.equal(ack.result.structuredContent.reachability.uiBadge, 'room_ui_v2');
    assert.equal(store.agentHeartbeats.pendingWakes(agent.identityId).length, 0);
    const receipt = { qualified: true, replyStatus: 'answered', signalAcknowledged: true, reachabilityObserved: true, uiBadge: 'room_ui_v2' };
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.equal(stderr.includes(secret), false);
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } finally {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if ((stderr + buffer + JSON.stringify(frames)).includes(secret)) throw new Error('Qualification output included the saved credential');
  }
}

try { await qualify(); }
catch (error) {
  const message = String(error?.message ?? error);
  console.error(JSON.stringify({ qualified: false, message: message.includes('pri_') ? 'Qualification failed.' : message }));
  process.exitCode = 1;
}
