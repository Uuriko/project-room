import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { readWorkSelection, workReadRefusal } from '../client/work-preparation.mjs';
import { textVersion } from '../server/text-results.mjs';
import { saveAgentConnection } from '../client/agent-connection.mjs';
import { openMcpTestClient } from '../scripts/mcp-test-client.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function setup(t) {
  const f = createAcceptanceFixture(), id = 'test-handoff';
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const config = { version: 1, origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer };
  const send = (type, data, actor = 'producer') => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type, data });
  const item = () => f.store.room('commons').state.workItems[id];
  const mutate = (type, data = {}, actor) => send(type, { workItemId: id, expectedRevision: item().revision, ...data }, actor);
  mutate('work.accepted'); mutate('work.started');
  const complete = body => {
    const post = send('message.posted', { messageId: randomUUID(), workItemId: id, body });
    return mutate('work.completed', { evidenceKind: 'room_text', evidenceMessageId: post.event.data.messageId,
      evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: item().receipt?.eventId ?? null,
      producerId: 'producer', summary: 'Exact review packet', nextAction: 'Review this result' });
  };
  return { ...f, id, origin, config, send, item, complete, client: new RoomAgentClient(config) };
}

test('one review read returns exact evidence and current gates through hosted and stdio without writes', async t => {
  const f = await setup(t), body = '\uFEFF  Café e\u0301 🪷\r\n\tExact result.  \n';
  const empty = await readWorkSelection(f.client, { workItemId: f.id, includeResult: true });
  assert.equal(empty.review.result.kind, 'none');
  const completion = f.complete(body);
  const reader = f.store.identities.create('Review reader');
  linkWithProof(f.store, f.keys.owner, 'commons', reader, { displayName: 'Review reader', permissions: [] });
  const beforeRead = f.store.room('commons').sequence;
  const config = join(f.directory, 'agent'); saveAgentConnection(config, { ...f.config, memberId: reader.identityId, token: reader.secret });
  const stdio = await openMcpTestClient(config); t.after(() => stdio.close());
  const hostedRaw = async args => (await (await fetch(`${f.origin}/room/mcp?profile=full`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reader.secret}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'review', method: 'tools/call', params: { name: 'room_read_work', arguments: { roomId: 'commons', ...args } } }) })).json());
  for (const call of [async args => { const r = await hostedRaw(args); return r.result ?? { error: r.error }; }, async args => { const r = await stdio.call('room_read_work', args); return r.result ?? { error: r.error }; }]) {
    for (const brief of [false, true]) {
      const result = await call({ workItemId: f.id, includeResult: true, includeDiscussion: true, brief });
      assert.equal(result.isError ?? false, false);
      assert.ok(result.structuredContent);
      const packet = result.structuredContent;
      assert.equal(packet.review.result.text.body, body);
      assert.equal(packet.review.completionEventId, completion.event.id);
      assert.equal(packet.review.result.receipt.producerId, 'producer');
      assert.equal(packet.review.workRevision, f.item().revision);
      assert.equal(packet.review.atomicSnapshot, false);
      assert.ok(packet.preparation.discussion.checkpoint);
      if (!brief) assert.equal(packet.next.action, 'verify');
    }
    const invalid = await call({ workItemIds: [f.id], includeResult: true });
    assert.ok(invalid.isError || invalid.error);
    assert.equal(JSON.stringify(invalid).includes(body), false);
  }
  assert.equal(f.store.room('commons').sequence, beforeRead);
});

test('a new completion between result and final context refuses the whole review packet', async t => {
  const f = await setup(t); f.complete('Original');
  const original = f.client.workResult.bind(f.client);
  f.client.workResult = async (...args) => { const value = await original(...args);
    f.send('work.blocked', { workItemId: f.id, expectedRevision: f.item().revision, reason: 'Revise', nextAction: 'Replace' });
    f.send('work.blocker_resolved', { workItemId: f.id, expectedRevision: f.item().revision, resolution: 'Ready' });
    f.complete('Replacement'); return value; };
  await assert.rejects(readWorkSelection(f.client, { workItemId: f.id, includeResult: true }), error => {
    assert.equal(workReadRefusal(error).code, 'review_changed'); return true;
  });
});

test('membership revocation after result read prevents any review content being returned', async t => {
  const f = await setup(t); f.complete('Private room evidence');
  const original = f.client.workResult.bind(f.client);
  f.client.workResult = async (...args) => {
    const value = await original(...args), member = f.store.room('commons').state.members.producer;
    f.send('member.access_changed', { memberId: 'producer', expectedMemberRevision: member.revision, permissions: [], active: false }, 'owner');
    return value;
  };
  await assert.rejects(readWorkSelection(f.client, { workItemId: f.id, includeResult: true }));
});

test('review packets have a byte bound independent of single-task defaults', async t => {
  const f = await setup(t); f.complete('Small result');
  const original = f.client.workContext.bind(f.client);
  f.client.workContext = async (...args) => ({ ...await original(...args), padding: '🪷'.repeat(40000) });
  await assert.rejects(readWorkSelection(f.client, { workItemId: f.id, includeResult: true }), error => {
    assert.equal(workReadRefusal(error).code, 'review_too_large'); return true;
  });
});

for (const field of ['viewerAccountId', 'viewerAuthEpoch', 'viewerSessionBinding', 'viewerSessionRevision']) {
  test(`same-member ${field} change refuses a mixed-session packet`, async t => {
    const f = await setup(t); f.complete('Session-bound evidence');
    const original = f.client.workResult.bind(f.client);
    f.client.workResult = async (...args) => ({ ...await original(...args), [field]: 'changed-session' });
    await assert.rejects(readWorkSelection(f.client, { workItemId: f.id, includeResult: true }), error => {
      assert.equal(workReadRefusal(error).code, 'review_changed'); return true;
    });
  });
}

test('withdrawn native evidence cannot escape in a prepared review', async t => {
  const f = await setup(t); f.complete('Withdraw this body');
  const original = f.client.workResult.bind(f.client);
  f.client.workResult = async (...args) => {
    const value = await original(...args);
    f.send('message.deleted', { messageId: value.result.text.messageId, expectedMessageRevision: 0 }, 'owner');
    return value;
  };
  await assert.rejects(readWorkSelection(f.client, { workItemId: f.id, includeResult: true }), error => {
    assert.equal(workReadRefusal(error).code, 'review_changed'); return true;
  });
});

test('discussion included in a review is fenced to the same read session', async t => {
  const f = await setup(t); f.complete('Bounded discussion review');
  const original = f.client.workDiscussion.bind(f.client);
  f.client.workDiscussion = async (...args) => ({ ...await original(...args), viewerSessionBinding: 'other-session' });
  await assert.rejects(readWorkSelection(f.client, { workItemId: f.id, includeResult: true, includeDiscussion: true }), error => {
    assert.equal(workReadRefusal(error).code, 'review_changed'); return true;
  });
});
