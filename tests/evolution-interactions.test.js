import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { openEvolution } from '../client/evolution/store.mjs';
import { prepareRoomInteraction, openRoomInteraction, readRoomInteraction } from '../client/evolution/interactions.mjs';
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolution-interactions-')), room = new RoomStore(join(dir, 'room.sqlite'));
  room.initialize(initialRoom()); const owner = room.issueAccessKey('commons', 'owner');
  room.command(owner, 'commons', { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: 'worker', displayName: 'worker', kind: 'agent', permissions: [] } });
  const token = room.issueAccessKey('commons', 'worker');
  room.command(owner, 'commons', { id: crypto.randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: 'source', body: 'Verify this work', toMemberId: 'worker', requestKind: 'reply' } });
  const server = createRoomServer({ store: room }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'worker', token };
  const directory = join(dir, 'state'); let store = openEvolution(directory);
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); room.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = await new RoomAgentClient(connection).replyContext('source');
  const scope = { origin: connection.origin, roomId: 'commons', roomCreatedEventId: source.roomCreatedEventId, viewerId: 'worker', authorizationRevision: 'local-policy-1' };
  const attempt = { operationId: 'op', attemptId: 'attempt-1', packageHash: 'a'.repeat(64) };
  const interaction = prepareRoomInteraction(connection, { version: 1, id: 'ask-1', scope, attempt, kind: 'approval', state: 'open',
    payload: { recipientId: 'owner', prompt: 'Approve this exact operation?', expiresAt: Date.now() + 60000, operationDigest: 'b'.repeat(64) } });
  return { room, connection, scope, attempt, interaction, get store() { return store; }, restart() { store.close(); store = openEvolution(directory); },
    async answer(requestMessageId, body) {
      // Human uses the exact current response basis from the authenticated API.
      const response = await fetch(connection.origin + '/api/rooms/commons/reply-context?requestMessageId=' + requestMessageId,
        { headers: { Authorization: `Bearer ${owner}` } });
      const context = await response.json();
      room.command(owner, 'commons', { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: {
        messageId: crypto.randomUUID(), body, replyToId: requestMessageId, responseToRequestId: requestMessageId,
        responseOutcome: 'answered', toMemberId: 'worker', workItemId: null, ...context.current.answerBasis } });
    } };
}
test('question persists across restart and an exact decision remains distinct from execution authority', async t => {
  const f = await fixture(t), args = { connection: f.connection, interaction: f.interaction, sourceRequestMessageId: 'source' };
  const opened = await openRoomInteraction(f.store, args); f.restart();
  assert.deepEqual(await openRoomInteraction(f.store, args), opened);
  const read = () => readRoomInteraction(f.store, { connection: f.connection, key: opened.key, scope: f.scope, attempt: f.attempt });
  assert.equal((await read()).status, 'open');
  const answer = { decision: 'approve', attemptId: f.attempt.attemptId, operationDigest: f.interaction.payload.operationDigest };
  await f.answer(opened.requestMessageId, JSON.stringify(answer)); f.restart();
  const result = await read(); assert.deepEqual(result.answer, answer); assert.equal(result.executionAuthorized, false);
  for (const args of [{ attempt: { ...f.attempt, attemptId: 'new' } }, { scope: { ...f.scope, authorizationRevision: 'new' } }, { now: f.interaction.payload.expiresAt }]) {
    await assert.rejects(readRoomInteraction(f.store, { connection: f.connection, key: opened.key, scope: f.scope, attempt: f.attempt, ...args }));
  }
});
test('ordinary yes text is not interpreted as an approval and reused IDs cannot change the operation', async t => {
  const f = await fixture(t), args = { connection: f.connection, interaction: f.interaction, sourceRequestMessageId: 'source' };
  const opened = await openRoomInteraction(f.store, args);
  await assert.rejects(openRoomInteraction(f.store, { ...args, interaction: { ...f.interaction, payload: { ...f.interaction.payload, operationDigest: 'c'.repeat(64) } } }), /id_reused/);
  await f.answer(opened.requestMessageId, 'yes');
  await assert.rejects(readRoomInteraction(f.store, { connection: f.connection, key: opened.key, scope: f.scope, attempt: f.attempt }), /decision_invalid/);
});
test('lost question response retries the original durable command after restart', async t => {
  const f = await fixture(t); let dropped = false;
  const connection = { ...f.connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!dropped && response.ok && options.method === 'POST' && options.body?.includes('Project Room interaction')) {
      dropped = true; await response.body.cancel(); throw Error('lost_question_response');
    }
    return response;
  } };
  const args = { connection, interaction: f.interaction, sourceRequestMessageId: 'source' };
  await assert.rejects(openRoomInteraction(f.store, args)); f.restart();
  const opened = await openRoomInteraction(f.store, args);
  assert.equal(opened.requestMessageId, f.interaction.payload.requestMessageId);
  const result = await readRoomInteraction(f.store, { connection, key: opened.key, scope: f.scope, attempt: f.attempt });
  assert.equal(result.status, 'open');
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM settings WHERE id LIKE 'interaction-%'").get().n, 1);
});
