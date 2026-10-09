// FIX-15 (WAVE-300): an orphaned claim's wake goes to the successor or the
// claim reaper, not to the dead owner alone. Orphaning a claim (lease lapse
// detected by the expiry sweep) emits a claim.orphaned receipt; the wake
// routes to the elected successor when one exists (and claim.successor_assigned
// fires when FIX-17's election picks one), otherwise to the claim reaper —
// the room owner, the room's claim-management authority. Fail-first: before
// the fix the sweep wakes only the dead owner and emits no orphaned event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { emitOrphanClaimWake, emitSuccessorAssigned, claimReaperId } from '../server/work-claim-events.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: ['verify', 'accept_work', 'complete_work'] } });
  // 'heir' is a plain member: distinct from the dead owner ('reviewer') and
  // from the claim reaper ('owner'), so the tests can tell the wake targets
  // apart.
  store.command(ownerKey, 'commons', { id: 'add-heir', type: 'member.added',
    data: { memberId: 'heir', displayName: 'Heir', kind: 'human', permissions: [] } });
  const peerKey = store.issueAccessKey('commons', 'reviewer');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const wakeCalls = [];
  const hb = store.agentHeartbeats;
  const originalEnqueueWake = hb.enqueueWake.bind(hb);
  hb.enqueueWake = payload => { wakeCalls.push(payload); return originalEnqueueWake(payload); };
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { store, wakeCalls,
    owner: new RoomAgentClient({ origin, roomId: 'commons', token: ownerKey }),
    peer: new RoomAgentClient({ origin, roomId: 'commons', token: peerKey }) };
}

const claimEvents = async client => (await client.changes(0, 100)).events
  .filter(row => row.event.type === 'work_claim.updated')
  .map(row => ({ seq: row.sequence, actor: row.event.actorId, at: row.event.at, ...row.event.data }));

test('a lapsed lease emits claim.orphaned and wakes the claim reaper, not just the dead owner', async t => {
  const { store, wakeCalls, owner, peer } = await fixture(t);
  await owner.workClaimCreate({ id: 'orphan-1', title: 'Orphan One', files: ['docs/held.md'] });
  const claimed = await peer.claimWorkItem('orphan-1', { leaseHours: 1 });
  assert.equal(claimed.owner, 'reviewer');
  const row = store.workClaims.get('commons', 'orphan-1');
  store.workClaims.set('commons', { ...row, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  wakeCalls.length = 0;
  await owner.workClaims(); // board read runs the expiry sweep

  const events = await claimEvents(owner);
  const orphaned = events.filter(e => e.action === 'orphaned');
  assert.equal(orphaned.length, 1, 'one claim.orphaned receipt per orphaned claim');
  assert.equal(orphaned[0].workClaim, 'orphan-1');
  assert.equal(orphaned[0].claimState, 'unclaimed', 'the claim was released by the sweep');
  assert.equal(orphaned[0].ownerId, null);
  assert.equal(orphaned[0].previousOwnerId, 'reviewer', 'the receipt names the dead owner');
  assert.equal(orphaned[0].successorId, undefined, 'no successor was elected on this path');

  const orphanWakes = wakeCalls.filter(w => String(w.messageId).startsWith('work-claim:orphan-1:orphaned:'));
  assert.equal(orphanWakes.length, 1, 'one orphan wake');
  assert.equal(orphanWakes[0].agentId, 'owner', 'the orphan wake reaches the claim reaper (room owner), not the dead owner alone');

  const expired = events.filter(e => e.action === 'lease_expired');
  assert.equal(expired.length, 1, 'the existing lease_expired receipt is unchanged by FIX-15');
});

test('claimReaperId is the room owner — the claim-management authority', async t => {
  const { store } = await fixture(t);
  assert.equal(claimReaperId(store, 'commons'), 'owner');
});

test('when a successor was elected, the orphan wake goes to the successor', async t => {
  const { store, wakeCalls, owner } = await fixture(t);
  await owner.workClaimCreate({ id: 'succ-1', title: 'Succ One' });
  const before = store.workClaims.get('commons', 'succ-1');
  const item = { ...before, state: 'unclaimed', owner: null };
  wakeCalls.length = 0;
  // The successor election (FIX-17) picked 'heir' before the sweep noticed
  // the orphan; the routing layer hands the election result in as successorId.
  const receipt = emitOrphanClaimWake(store, 'commons', {
    item, previousOwnerId: 'reviewer', successorId: 'heir', actorId: 'reviewer'
  });
  assert.ok(receipt, 'an orphaned receipt is emitted');
  const orphanWakes = wakeCalls.filter(w => String(w.messageId).startsWith('work-claim:succ-1:orphaned:'));
  assert.equal(orphanWakes.length, 1, 'one orphan wake');
  assert.equal(orphanWakes[0].agentId, 'heir', 'the wake follows the elected successor, not the reaper');
  assert.notEqual(orphanWakes[0].agentId, 'reviewer', 'and never only the dead owner');

  const events = await claimEvents(owner);
  const orphaned = events.filter(e => e.action === 'orphaned' && e.workClaim === 'succ-1');
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0].successorId, 'heir', 'the receipt names the elected successor');
  assert.equal(orphaned[0].previousOwnerId, 'reviewer');
});

test('claim.successor_assigned fires when the successor is elected, waking the successor', async t => {
  const { store, wakeCalls, owner } = await fixture(t);
  await owner.workClaimCreate({ id: 'succ-2', title: 'Succ Two' });
  // The election consumer (FIX-12's POST .../succeed over FIX-17's
  // electSuccessor) already moved ownership; this is the notification.
  const item = { ...store.workClaims.get('commons', 'succ-2'), state: 'claimed', owner: 'heir' };
  wakeCalls.length = 0;
  const receipt = emitSuccessorAssigned(store, 'commons', {
    item, successorId: 'heir', previousOwnerId: 'reviewer', actorId: 'reviewer'
  });
  assert.ok(receipt, 'a successor_assigned receipt is emitted');
  const events = await claimEvents(owner);
  const assigned = events.filter(e => e.action === 'successor_assigned' && e.workClaim === 'succ-2');
  assert.equal(assigned.length, 1, 'one claim.successor_assigned event');
  assert.equal(assigned[0].ownerId, 'heir');
  assert.equal(assigned[0].previousOwnerId, 'reviewer');
  assert.equal(assigned[0].successorId, 'heir');
  const wakes = wakeCalls.filter(w => String(w.messageId).startsWith('work-claim:succ-2:successor_assigned:'));
  assert.equal(wakes.length, 1, 'the successor is woken once');
  assert.equal(wakes[0].agentId, 'heir');
});
