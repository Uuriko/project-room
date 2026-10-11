import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const api = async (input, status = 200, actor = 'owner') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/assistant`, {
      method: 'POST', headers: { authorization: `Bearer ${f.keys[actor]}`, 'content-type': 'application/json' }, body: JSON.stringify(input)
    });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const configure = () => api({ action: 'configure', requestId: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  const input = { action: 'invoke', requestId: 'admit', runId: 'run-new', sourceMessageId: 'message-new', message: { body: 'Please check our project.' } };
  return { f, api, configure, input };
}

test('atomic admission creates a human message and one queued request with exact retry', async t => {
  const { f, api, configure, input } = await setup(t); await configure();
  const receipt = await api(input);
  assert.equal(receipt.result.status, 'queued');
  assert.deepEqual(await api(input), receipt);
  const messages = f.store.room('commons').state.messages.filter(message => message.id === input.sourceMessageId);
  assert.equal(messages.length, 1); assert.equal(messages[0].authorId, 'owner');
  assert.equal(messages[0].body, input.message.body);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM room_assistant_runs').get().n, 1);
  await api({ ...input, message: { body: 'Changed content' } }, 409);
});

test('an unavailable coordinator rolls back the message instead of stranding it', async t => {
  const { f, api, input } = await setup(t);
  const response = await api(input, 409); assert.equal(response.error.code, 'assistant_not_connected');
  assert.equal(f.store.room('commons').state.messages.some(message => message.id === input.sourceMessageId), false);
});

test('a run collision rolls back the second message and retains the original', async t => {
  const { f, api, configure, input } = await setup(t); await configure(); await api(input);
  await api({ ...input, requestId: 'another', sourceMessageId: 'another-message' }, 409);
  assert.equal(f.store.room('commons').state.messages.some(message => message.id === 'another-message'), false);
  assert.equal(f.store.room('commons').state.messages.filter(message => message.id === input.sourceMessageId).length, 1);
});

test('atomic admission retains normal message validation and forbids private payloads', async t => {
  const { f, api, configure, input } = await setup(t); await configure();
  await api({ ...input, message: { body: 'Private', toMemberId: 'producer' } }, 422);
  await api({ ...input, message: { body: 'Missing channel', channelId: 'absent' } }, 422);
  assert.equal(f.store.room('commons').state.messages.some(message => message.id === input.sourceMessageId), false);
});

test('an agent cannot impersonate a human by using atomic admission', async t => {
  const { f, api, configure, input } = await setup(t); await configure();
  await api(input, 403, 'producer');
  assert.equal(f.store.room('commons').state.messages.some(message => message.id === input.sourceMessageId), false);
});
