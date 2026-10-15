import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { readWorkSelection } from '../client/work-preparation.mjs';
import { textVersion } from '../server/text-results.mjs';

async function setup(t) {
  const f = createAcceptanceFixture();
  const outsider = f.store.identities.create('Unrelated review reader');
  f.store.identities.link(f.keys.owner, 'commons', { identityId: outsider.identityId, displayName: 'Unrelated review reader', permissions: [] });
  f.keys.outsider = outsider.secret;
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const member = actor => f.store.authenticate(f.keys[actor], 'commons').member.id;
  const send = (actor, type, data) => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type, data });
  const client = actor => new RoomAgentClient({ version: 1, origin, roomId: 'commons', memberId: member(actor), token: f.keys[actor] });
  const file = async (actor, path = '', data) => {
    const response = await fetch(`${origin}/api/rooms/commons/files${path}`, {
      method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${f.keys[actor]}`, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, member, send, client, file };
}

test('prepared exact review over HTTP preserves DM parties and denies an unrelated agent', async t => {
  const f = await setup(t), id = 'test-handoff', body = 'Private DM result — only its two participants may read this.';
  const item = () => f.store.room('commons').state.workItems[id];
  const mutate = (type, data = {}) => f.send('producer', type, { workItemId: id, expectedRevision: item().revision, ...data });
  mutate('work.accepted'); mutate('work.started');
  const post = f.send('producer', 'message.posted', { messageId: randomUUID(), workItemId: id, toMemberId: f.member('reviewer'), body });
  const completion = mutate('work.completed', {
    evidenceKind: 'room_text', evidenceMessageId: post.event.data.messageId,
    evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: null,
    producerId: f.member('producer'), summary: 'Review completed evidence', nextAction: 'Review'
  });
  const before = f.store.room('commons').sequence;
  for (const actor of ['producer', 'reviewer']) {
    const packet = await readWorkSelection(f.client(actor), { workItemId: id, includeResult: true, includeDiscussion: true });
    assert.equal(packet.review.result.text.body, body, `${actor} retains exact DM evidence`);
    assert.equal(packet.review.completionEventId, completion.event.id);
  }
  for (const actor of ['outsider']) {
    await assert.rejects(readWorkSelection(f.client(actor), { workItemId: id, includeResult: true, includeDiscussion: true }), error => {
      assert.equal(error.code, 'result_unavailable', `${actor} must not receive a review packet`);
      assert.equal(JSON.stringify(error).includes(body), false);
      return true;
    });
  }
  assert.equal(f.store.room('commons').sequence, before, 'review preparation is read-only');
});

test('archived DM attachment remains downloadable only by its author and recipient over HTTP', async t => {
  const f = await setup(t), id = randomUUID(), messageId = randomUUID();
  const data = Buffer.from('Private archived DM attachment bytes').toString('base64');
  assert.equal((await f.file('owner', '', { id, filename: 'private.txt', mediaType: 'text/plain', data })).status, 201);
  f.send('owner', 'message.posted', { messageId, toMemberId: f.member('producer'), body: 'Private attachment' });
  assert.equal((await f.file('owner', `/${id}/commit`, { messageId })).status, 200);
  for (let i = 0; i < 6; i++) f.send('owner', 'message.posted', { messageId: randomUUID(), body: `Later public message ${i}` });
  for (let i = 0; i < 20; i++) if (f.store.backfillMessages({ limit: 1000 }).done) break;
  assert.equal(f.store.checkMessagesParity().ok, true);
  assert.ok(f.store.archiveMessages('commons', { keepNewest: 2, dryRun: false }).archived > 0);
  assert.equal(f.store.room('commons').state.messages.some(message => message.id === messageId), false, 'exercise archived lookup');
  for (const actor of ['reviewer', 'guest']) {
    const denied = await f.file(actor, `/${id}`);
    assert.equal(denied.status, 404);
    assert.equal(JSON.stringify(denied.body).includes(data), false);
    assert.equal((await f.file(actor)).body.files.some(file => file.id === id), false);
  }
  for (const actor of ['owner', 'producer']) {
    const allowed = await f.file(actor, `/${id}`);
    assert.equal(allowed.status, 200, `${actor} retains archived DM attachment access`);
    assert.equal(allowed.body.attachment.data, data);
    assert.equal((await f.file(actor)).body.files.some(file => file.id === id), true);
  }
});
