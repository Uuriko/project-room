// Work-claim changes become room events: before this, claims lived only in the
// work_claims table, so the room, the event tail and agents' wake feeds never
// saw a claim, a renewal, a handoff or a release, and agents re-announced every
// claim in chat. Each committed change now appends one work_claim.updated event
// attributed to the member who made it, and a refused change appends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { applyEvent, emptyRoomState } from '../src/events.js';
import { workClaimEventData } from '../server/work-claim-events.mjs';

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
  return { store,
    owner: new RoomAgentClient({ origin, roomId: 'commons', token: ownerKey }),
    peer: new RoomAgentClient({ origin, roomId: 'commons', token: peerKey }) };
}

const claimEvents = async client => (await client.changes(0, 100)).events
  .filter(row => row.event.type === 'work_claim.updated')
  .map(row => ({ seq: row.sequence, actor: row.event.actorId, ...row.event.data }));

test('each claim change appends one event naming the member, the action, the owner and the files', async t => {
  const { owner, peer } = await fixture(t);
  const created = await owner.workClaimCreate({ id: 'lane-a', title: 'Lane A', files: ['server/a.mjs'] });
  assert.equal(created.history[0].agentId, 'owner', 'creation is attributed to the creating member');
  const claimed = await owner.claimWorkItem('lane-a', { leaseHours: 2 });
  await owner.updateWorkItem('lane-a', { state: 'in_progress' });
  await owner.reassignWorkItem('lane-a', { newOwner: 'reviewer', note: 'handoff' });
  await peer.releaseWorkItem('lane-a', { note: 'parked' });

  const events = await claimEvents(owner);
  assert.deepEqual(events.map(e => [e.actor, e.action, e.claimState, e.ownerId]), [
    ['owner', 'created', 'unclaimed', null],
    ['owner', 'claimed', 'claimed', 'owner'],
    ['owner', 'state_changed', 'in_progress', 'owner'],
    ['owner', 'reassigned', 'in_progress', 'reviewer'],
    ['reviewer', 'released', 'unclaimed', null]
  ]);
  assert.ok(events.every(e => e.workClaim === 'lane-a' && e.title === 'Lane A'));
  assert.deepEqual(events[1].paths, ['server/a.mjs']);
  assert.equal(events[1].leaseExpiresAt, claimed.leaseExpiresAt);
  assert.equal(events[3].previousOwnerId, 'owner');
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq), 'events land in commit order');
});

test('a refused claim change appends no event', async t => {
  const { owner, peer } = await fixture(t);
  await owner.workClaim('held', { files: ['docs/x.md'] });
  const before = (await claimEvents(owner)).length;
  await assert.rejects(peer.claimWorkItem('held'), error => error.status === 409);
  await assert.rejects(peer.releaseWorkItem('held'), error => error.status === 403);
  await assert.rejects(owner.reassignWorkItem('held', { newOwner: 'nobody-here' }), error => error.status === 422);
  assert.equal((await claimEvents(owner)).length, before);
});

test('a lapsed lease is swept with a lease_expired event for the previous owner', async t => {
  const { store, owner } = await fixture(t);
  await owner.workClaim('short', { leaseHours: 1 });
  const row = store.workClaims.get('commons', 'short');
  store.workClaims.set('commons', { ...row, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  await owner.workClaims();
  const [expired] = (await claimEvents(owner)).filter(e => e.action === 'lease_expired');
  assert.deepEqual([expired.actor, expired.claimState, expired.ownerId, expired.previousOwnerId], ['owner', 'unclaimed', null, 'owner']);
});

test('the full event log, claim events included, replays from an empty room', async t => {
  const { store, owner } = await fixture(t);
  await owner.workClaim('replayed', { files: ['src/r.js'], leaseHours: 1 });
  await owner.releaseWorkItem('replayed', { note: 'parked' });
  const rows = store.db.prepare('SELECT body FROM events WHERE room_id=? ORDER BY sequence').all('commons');
  let state = emptyRoomState();
  for (const { body } of rows) state = applyEvent(state, JSON.parse(body));
  assert.equal(state.room.id, 'commons');
  assert.ok(rows.some(({ body }) => JSON.parse(body).type === 'work_claim.updated'));
});

test('a member cannot forge a claim event through the command path', async t => {
  const { store } = await fixture(t);
  const key = store.issueAccessKey('commons', 'reviewer');
  const item = { id: 'w', state: 'claimed', owner: 'reviewer', leaseExpiresAt: null, title: 'w', files: [] };
  assert.throws(() => store.command(key, 'commons', { id: 'forged', type: 'work_claim.updated', data: workClaimEventData(item, 'claimed') }));
  const rows = store.db.prepare("SELECT body FROM events WHERE room_id=?").all('commons');
  assert.ok(!rows.some(({ body }) => JSON.parse(body).type === 'work_claim.updated'));
});

test('the event payload refuses an action the reducer does not know', () => {
  const item = { id: 'w', state: 'claimed', owner: 'a', leaseExpiresAt: null, title: 'w', files: [] };
  assert.throws(() => workClaimEventData(item, 'teleported'), /Unknown work claim action/);
  assert.throws(() => applyEvent(emptyRoomState(), {
    id: 'e1', idempotencyKey: 'k1', roomId: 'commons', type: 'work_claim.updated', actorId: 'owner', at: new Date().toISOString(),
    data: { ...workClaimEventData(item, 'claimed'), action: 'teleported' }
  }));
});
