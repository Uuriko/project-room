import test from 'node:test';
import assert from 'node:assert/strict';
import { watchSharedAssistant } from '../client/shared-assistant-watch.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomAssistant } from '../server/room-assistant.mjs';
import { randomUUID } from 'node:crypto';

test('watch picks oldest unclaimed work, serially, without executing other or stopped attempts', async () => {
  const controller = new AbortController(), calls = [];
  const runs = [
    { id: 'new', createdAt: 2 }, { id: 'old', createdAt: 1 },
    { id: 'claimed', attemptId: 'another-host' },
    { id: 'foreign', coordinatorMemberId: 'other' },
    { id: 'paused', status: 'paused' }, { id: 'deleted', sourceDeleted: true }
  ].map(run => ({ status: 'queued', coordinatorMemberId: 'room', ...run }));
  await watchSharedAssistant({ memberId: 'room', signal: controller.signal,
    client: { assistant: async () => ({ assistant: { coordinatorMemberId: 'room' }, runs }) },
    execute: async id => {
      calls.push(id);
      await Promise.resolve();
      runs.find(run => run.id === id).status = 'done';
      if (calls.length === 2) controller.abort();
    }
  });
  assert.deepEqual(calls, ['old', 'new']);
});

test('idle watcher reports state once and aborts its wait without a request', async () => {
  const controller = new AbortController(), events = [];
  let reads = 0;
  await watchSharedAssistant({ memberId: 'room', signal: controller.signal, pollMs: 100,
    client: { assistant: async () => {
      if (++reads === 3) controller.abort();
      return { assistant: { coordinatorMemberId: 'other' }, runs: [{ id: 'old', status: 'queued', coordinatorMemberId: 'room' }] };
    } },
    execute: () => assert.fail('A replaced coordinator must not start work'), emit: event => events.push(event)
  });
  assert.equal(reads, 3);
  assert.deepEqual(events, [{ type: 'watch_status', state: 'not_configured' }]);
});

test('ambiguous execution failure stops discovery instead of rerunning or starting another task', async () => {
  let executions = 0, reads = 0;
  const error = new Error('Publication receipt was lost');
  await assert.rejects(watchSharedAssistant({ memberId: 'room',
    client: { assistant: async () => {
      reads++;
      return { assistant: { coordinatorMemberId: 'room' }, runs: [{ id: 'one', createdAt: 1, status: 'queued', coordinatorMemberId: 'room' }] };
    } }, execute: async () => { executions++; throw error; }
  }), error);
  assert.equal(executions, 1);
  assert.equal(reads, 1);
});

test('cancellation while fetching does not dispatch returned work', async () => {
  const controller = new AbortController();
  await watchSharedAssistant({ memberId: 'room', signal: controller.signal,
    client: { assistant: async () => {
      controller.abort();
      return { assistant: { coordinatorMemberId: 'room' }, runs: [{ id: 'one', status: 'queued', coordinatorMemberId: 'room' }] };
    } }, execute: () => assert.fail('Aborted discovery must not execute')
  });
});

test('watch discovers a real human request over HTTP and uses the existing fenced claim/publication path', async t => {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const assistant = new RoomAssistant(f.store);
  const apply = (actor, input) => assistant.apply('commons', { requestId: randomUUID(), ...input }, () => f.store.authenticate(f.keys[actor], 'commons'));
  apply('owner', { action: 'configure', name: 'Room', expectedRevision: 0, coordinatorMemberId: 'producer' });
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: 'human-ask', body: 'Please check this project.' } });
  apply('owner', { action: 'invoke', runId: 'shared', sourceMessageId: 'human-ask' });
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  const controller = new AbortController();
  await watchSharedAssistant({ client, memberId: 'producer', signal: controller.signal,
    execute: async id => {
      const claim = await client.assistant({ action: 'claim', requestId: 'pickup', runId: id, attemptId: 'host', expectedRevision: 0 });
      await client.assistant({ action: 'publish', requestId: 'result', runId: id, attemptId: 'host', expectedRevision: claim.result.revision,
        body: 'Project checked.', summary: 'Complete.', appliedInputMessageIds: ['human-ask'] });
      controller.abort();
    }
  });
  const run = assistant.list('commons', () => f.store.authenticate(f.keys.owner, 'commons')).runs[0];
  assert.equal(run.status, 'done');
  const messages = f.store.room('commons').state.messages.filter(message => message.id === run.resultMessageId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].replyToId, 'human-ask');
});
