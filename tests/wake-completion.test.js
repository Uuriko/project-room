import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeReplyWake } from '../client/wake-completion.mjs';

function fixture() {
  const signal = { signalId: 'signal', kind: 'mention', roomId: 'room', messageId: 'original' };
  const original = { id: 'original', authorId: 'human', body: 'Question' };
  const answer = { id: 'answer', authorId: 'agent', replyToId: 'original', body: 'Response' };
  let reads = 0, acks = 0;
  const options = { connection: { memberId: 'agent', roomId: 'room' }, hostId: 'host', signalId: 'signal', replyMessageId: 'answer',
    client: { messageThread: async id => ({ roomId: 'room', thread: id === 'original' ? original : answer }) },
    wake: { wait: async () => { reads++; return { pendingWakes: [signal] }; },
      ack: async () => { acks++; return { acknowledged: ['signal'] }; } } };
  return { options, signal, original, answer, counts: () => ({ reads, acks }) };
}
test('durable reply is verified before ACK; retry never posts', async () => {
  const f = fixture();
  assert.equal((await completeReplyWake(f.options)).status, 'reply_observed_and_acknowledged');
  assert.deepEqual(f.counts(), { reads: 2, acks: 1 });
  const ack = f.options.wake.ack; let attempts = 0;
  f.options.wake.ack = () => { if (++attempts === 1) throw new Error('lost_response'); return ack(); };
  await assert.rejects(completeReplyWake(f.options), /lost_response/);
  assert.equal((await completeReplyWake(f.options)).workCompletion, 'not_inferred');
});
test('foreign, unrelated, deleted, empty or wrong-audience replies never ACK', async () => {
  for (const patch of [{ authorId: 'other' }, { replyToId: 'other' }, { id: 'other' },
    { deletedAt: 'now' }, { body: '' }, { toMemberId: 'human' }]) {
    const f = fixture(); Object.assign(f.answer, patch);
    await assert.rejects(completeReplyWake(f.options), /reply_evidence_not_confirmed/);
    assert.equal(f.counts().acks, 0);
  }
  const f = fixture(); f.original.toMemberId = 'agent';
  await assert.rejects(completeReplyWake(f.options), /reply_evidence_not_confirmed/);
  f.answer.toMemberId = 'human';
  assert.equal((await completeReplyWake(f.options)).status, 'reply_observed_and_acknowledged');
});
test('requests, work, foreign rooms and missing signals are not completed', async () => {
  for (const patch of [{ kind: 'work' }, { requestId: 'request' }, { roomId: 'other' }]) {
    const f = fixture(); Object.assign(f.signal, patch);
    await assert.rejects(completeReplyWake(f.options), /unsupported_wake_completion/);
    assert.equal(f.counts().acks, 0);
  }
  const f = fixture(); f.options.wake.wait = async () => ({ pendingWakes: [] });
  assert.equal((await completeReplyWake(f.options)).status, 'not_observed_pending');
});
test('lost receiving lease and authority failure stop ACK', async () => {
  const f = fixture(); let reads = 0;
  f.options.wake.wait = async () => ++reads === 1 ? { pendingWakes: [f.signal] } : { status: 'listener_contended', pendingWakes: [] };
  assert.equal((await completeReplyWake(f.options)).status, 'listener_contended');
  assert.equal(f.counts().acks, 0);
  f.options.wake.wait = async () => { throw new Error('revoked'); };
  await assert.rejects(completeReplyWake(f.options), /revoked/);
});

test('scoped HTTP identity acknowledges its persisted reply and safely reruns', async t => {
  const { RoomStore } = await import('../server/store.mjs');
  const { initialRoom } = await import('../server/bootstrap.mjs');
  const { createRoomServer } = await import('../server/http.mjs');
  const { connectRoom } = await import('../client/agent-setup.mjs');
  const { readAgentConnection } = await import('../client/agent-connection.mjs');
  const { RoomAgentClient } = await import('../client/room-agent.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'room-completion-'));
  const store = new RoomStore(':memory:'); store.initialize(initialRoom('commons'));
  const owner = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const invite = store.invites.create(owner, 'commons', { profile: 'chat', displayName: 'Responder' });
  const setup = await connectRoom({ origin, directory, name: 'Responder', accept: true, target: invite.code });
  const connection = readAgentConnection(setup.configDirectory);
  const human = new RoomAgentClient({ origin, roomId: 'commons', token: owner });
  const agent = new RoomAgentClient(connection);
  const message = await human.say('A real question');
  const messageId = message.event.data.messageId;
  const signal = store.agentHeartbeats.enqueueWake({ agentId: setup.identityId, kind: 'mention', roomId: 'commons', messageId }).signal;
  const reply = await agent.say('A persisted answer', { replyToId: messageId });
  const options = { connection, hostId: 'completion-probe', signalId: signal.signalId, replyMessageId: reply.event.data.messageId };
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const env = { ...process.env, ROOM_AGENT_CONFIG: setup.configDirectory };
  for (const key of ['ROOM_AGENT_ORIGIN', 'ROOM_AGENT_ROOM', 'ROOM_AGENT_MEMBER', 'ROOM_AGENT_TOKEN']) delete env[key];
  const execute = () => promisify(execFile)(process.execPath, ['scripts/room-complete-wake.mjs',
    '--host', options.hostId, '--signal', options.signalId, '--reply', options.replyMessageId], { env, timeout: 15000 });
  const output = (await execute()).stdout;
  assert.equal(JSON.parse(output).status, 'reply_observed_and_acknowledged');
  assert.ok(!output.includes(connection.token));
  assert.equal(store.agentHeartbeats.pendingWakes(setup.identityId, { roomId: 'commons' }).length, 0);
  assert.equal(JSON.parse((await execute()).stdout).status, 'not_observed_pending');
  store.identities.unlink(owner, 'commons', setup.identityId);
  await assert.rejects(execute());
});
