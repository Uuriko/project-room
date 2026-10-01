// room-coord tail and the coordination digest lines over real HTTP: a wake
// loop reads only what concerns it from a checkpoint, and the checkpoint never
// makes it re-read a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { CoordError, claimAndVerify, digest, eventConcerns, handoff, tail } from '../client/room-coord.mjs';
import { run } from '../scripts/room-coord.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: [] } });
  const peerKey = store.issueAccessKey('commons', 'reviewer');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { owner: new RoomAgentClient({ origin, roomId: 'commons', token: ownerKey }),
    peer: new RoomAgentClient({ origin, roomId: 'commons', token: peerKey }) };
}

const coded = code => error => error instanceof CoordError && error.code === code;
const postedBodies = async (client, messageId) => (await client.changes(0, 100)).events
  .filter(row => row.event.type === 'message.posted' && row.event.data.messageId === messageId)
  .map(row => row.event.data.body);

test('tail returns only the events that concern the caller and a checkpoint that never rereads', async t => {
  const { owner, peer } = await fixture(t);
  await claimAndVerify(owner, 'relay', { memberId: 'owner', files: ['docs/relay.md'], leaseHours: 2 });
  for (const body of ['unrelated note', 'ping @Reviewer about docs', 'mail for @Reviewers is not for Reviewer']) {
    await owner.command({ id: `cmd-${body.length}`, type: 'message.posted', data: { messageId: `msg-${body.length}`, body } });
  }
  const { messageId } = await handoff(owner, 'relay', { to: 'reviewer', toHandle: 'Reviewer', summary: 'drafted' });

  const first = await tail(peer, { types: ['message'], mine: true, memberId: 'reviewer', handles: ['Reviewer'], pageSize: 2, maxPages: 20 });
  assert.deepEqual(first.events.map(e => e.summary), ['ping @Reviewer about docs', 'Handoff relay to @Reviewer']);
  assert.ok(first.events.every(e => e.type === 'message.posted' && e.actorId === 'owner' && Number.isSafeInteger(e.seq)));
  assert.equal(first.hasMore, false);
  assert.equal(first.after, (await peer.changes(0, 100)).next, 'the checkpoint sits at the end of what was scanned');
  assert.deepEqual(await postedBodies(owner, messageId), [`Handoff relay to @Reviewer\nDone: drafted\nFiles: docs/relay.md\nLease until ${(await owner.workClaimGet('relay')).leaseExpiresAt}`]);

  const again = await tail(peer, { after: first.after, types: ['message'], mine: true, memberId: 'reviewer', handles: ['Reviewer'] });
  assert.deepEqual([again.events, again.after], [[], first.after]);
  const capped = await tail(owner, { pageSize: 1, maxPages: 2 });
  assert.deepEqual([capped.events.length, capped.hasMore, capped.after], [2, true, capped.events[1].seq]);
});

test('claim and land events read as lane changes in the digest and count as the owner\'s business', () => {
  const claimRow = { sequence: 9, event: { type: 'work_claim.updated', actorId: 'owner',
    data: { workClaim: 'lane-a', action: 'reassigned', ownerId: 'reviewer', previousOwnerId: 'owner', leaseExpiresAt: '2026-10-02T00:00:00.000Z', paths: ['server/a.mjs'] } } };
  const landRow = { sequence: 10, event: { type: 'land.updated', actorId: 'owner', data: { repo: 'acme/demo', prNumber: 7, state: 'green' } } };
  assert.equal(digest({ events: [claimRow, landRow] }), [
    '## Activity (2 events)',
    '- seq 9 · owner · claim lane-a reassigned · owner reviewer · lease 2026-10-02T00:00:00.000Z · server/a.mjs',
    '- seq 10 · owner · land acme/demo#7 green'
  ].join('\n'));
  assert.equal(eventConcerns(claimRow.event, { memberId: 'reviewer' }), true);
  assert.equal(eventConcerns(landRow.event, { memberId: 'reviewer' }), false);
  assert.equal(eventConcerns({ type: 'message.posted', actorId: 'x', data: { body: 'cc @Grok Bot.' } }, { memberId: 'g', handles: ['@Grok Bot'] }), true);
});

test('the tail command refuses a bad checkpoint before reading', async t => {
  const { owner } = await fixture(t);
  const page = await run(['tail', '--types', 'message,member', '--after', '0'], { client: owner, memberId: 'owner' });
  assert.ok(page.events.length > 0 && page.events.every(e => /^(message|member)\./.test(e.type)));
  await assert.rejects(run(['tail', '--mine'], { client: owner }), coded('invalid_input'));
  await assert.rejects(run(['tail', '--pages', '0'], { client: owner, memberId: 'owner' }), coded('invalid_input'));
  await assert.rejects(run(['tail', '--after', '-1'], { client: owner, memberId: 'owner' }), coded('usage_error'));
});
