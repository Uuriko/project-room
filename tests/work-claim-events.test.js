// Work-claim changes become room events: before this, claims lived only in the
// work_claims table, so the room, the event tail and agents' wake feeds never
// saw a claim, a renewal, a handoff or a release, and agents re-announced every
// claim in chat. Each committed change now appends one work_claim.updated event
// attributed to the member who made it, and a refused change appends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { PILOT_LIMITS, RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { applyEvent, emptyRoomState } from '../src/events.js';
import { emitWorkClaimEvent, workClaimEventData } from '../server/work-claim-events.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: ['verify'] } });
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
  .map(row => ({ seq: row.sequence, actor: row.event.actorId, at: row.event.at, ...row.event.data }));

const roundOf = c => ({ expectedClaimedAt: c.claimedAt ?? c.claim?.claimedAt, expectedHistoryLength: (c.history?.length ?? c.claim?.history?.length ?? 0) + (c.historyOmitted ?? c.claim?.historyOmitted ?? 0) });
test('each claim change appends one event naming the member, the action, the owner and the files', async t => {
  const { owner, peer } = await fixture(t);
  const created = await owner.workClaimCreate({ id: 'lane-a', title: 'Lane A', files: ['server/a.mjs'] });
  assert.equal(created.history[0].agentId, 'owner', 'creation is attributed to the creating member');
  const claimed = await owner.claimWorkItem('lane-a', { leaseHours: 2 });
  await owner.updateWorkItem('lane-a', { state: 'in_progress' });
  await peer.reviewWorkItem('lane-a', { note: 'looks right' });
  // Renewals cite a public progress message posted after the lease started.
  await new Promise(resolve => setTimeout(resolve, 2));
  const progress = (await owner.say('Lane A is moving')).event.data.messageId;
  await owner.renewWorkItem('lane-a', { progressMessageId: progress, leaseHours: 3 });
  await owner.reassignWorkItem('lane-a', { newOwner: 'reviewer', note: 'handoff', ...roundOf(await owner.workClaimGet('lane-a')) });
  await peer.releaseWorkItem('lane-a', { note: 'parked', ...roundOf(await peer.workClaimGet('lane-a')) });

  const events = await claimEvents(owner);
  assert.deepEqual(events.map(e => [e.actor, e.action, e.claimState, e.ownerId]), [
    ['owner', 'created', 'unclaimed', null],
    ['owner', 'claimed', 'claimed', 'owner'],
    ['owner', 'state_changed', 'in_progress', 'owner'],
    ['reviewer', 'reviewed', 'in_progress', 'owner'],
    ['owner', 'renewed', 'in_progress', 'owner'],
    ['owner', 'reassigned', 'in_progress', 'reviewer'],
    ['reviewer', 'released', 'unclaimed', null]
  ]);
  assert.ok(events.every(e => e.workClaim === 'lane-a' && e.title === 'Lane A'));
  assert.ok(events.every(e => e.paths.length === 1 && e.paths[0] === 'server/a.mjs'),
    'release still names the files that were held, which the item itself clears');
  assert.equal(events[1].leaseExpiresAt, claimed.leaseExpiresAt);
  assert.equal(events[0].at, created.history[0].at, 'the receipt uses the same clock as the claim history');
  assert.equal(events[5].previousOwnerId, 'owner');
  assert.equal(events[6].previousOwnerId, undefined);
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq), 'events land in commit order');
});

test('a refused claim change appends no event', async t => {
  const { owner, peer } = await fixture(t);
  await owner.workClaim('held', { files: ['docs/x.md'] });
  const before = (await claimEvents(owner)).length;
  await assert.rejects(peer.claimWorkItem('held'), error => error.status === 409);
  await assert.rejects(peer.releaseWorkItem('held'), error => error.status === 403);
  await assert.rejects(owner.reassignWorkItem('held', { newOwner: 'nobody-here', ...roundOf(await owner.workClaimGet('held')) }), error => error.status === 422);
  assert.equal((await claimEvents(owner)).length, before);
});

test('a lapsed lease is swept once, naming the previous owner and the files that were freed', async t => {
  const { store, owner } = await fixture(t);
  await owner.workClaim('short', { files: ['docs/held.md'], leaseHours: 1 });
  const row = store.workClaims.get('commons', 'short');
  store.workClaims.set('commons', { ...row, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  await owner.workClaims();
  await owner.workClaims();
  const expired = (await claimEvents(owner)).filter(e => e.action === 'lease_expired');
  assert.equal(expired.length, 1, 'a later read of the board does not emit the expiry again');
  assert.deepEqual([expired[0].actor, expired[0].claimState, expired[0].ownerId, expired[0].previousOwnerId], ['owner', 'unclaimed', null, 'owner']);
  assert.deepEqual(expired[0].paths, ['docs/held.md']);
  assert.deepEqual(store.workClaims.get('commons', 'short').files, []);
});

test('the full event log, claim events included, replays from an empty room', async t => {
  const { store, owner } = await fixture(t);
  await owner.workClaim('replayed', { files: ['src/r.js'], leaseHours: 1 });
  await owner.releaseWorkItem('replayed', { note: 'parked', ...roundOf(await owner.workClaimGet('replayed')) });
  const rows = store.db.prepare('SELECT body FROM events WHERE room_id=? ORDER BY sequence').all('commons');
  let state = emptyRoomState();
  for (const { body } of rows) state = applyEvent(state, JSON.parse(body));
  assert.equal(state.room.id, 'commons');
  assert.ok(rows.some(({ body }) => JSON.parse(body).type === 'work_claim.updated'));
  const projection = JSON.parse(store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection);
  assert.deepEqual(projection.eventLog, []);
  assert.equal(projection.workClaims, undefined, 'the claim stays in the work_claims table, not the room projection');
});

test('a blank title is refused before any claim or event is recorded', async t => {
  const { owner } = await fixture(t);
  // Q3-A: a title that is empty once whitespace is removed is invalid input.
  await assert.rejects(owner.workClaimCreate({ id: 'blank-title', title: '   ' }),
    error => error.status === 422 && error.code === 'invalid_claim_input' && /title/.test(error.message));
  assert.equal((await claimEvents(owner)).length, 0);
});

test('an archived room still records a claim and appends no event', async t => {
  const { owner } = await fixture(t);
  // Archive with the owner's own key. Issuing a second key would revoke it.
  await owner.command({ id: 'archive-room', type: 'room.archived', data: { reason: 'pilot over' } });
  const created = await owner.workClaimCreate({ id: 'after-archive', title: 'Still recorded' });
  assert.equal(created.id, 'after-archive');
  assert.equal((await claimEvents(owner)).length, 0);
});

test('a member cannot forge a claim event through the command path', async t => {
  const { store } = await fixture(t);
  const key = store.issueAccessKey('commons', 'reviewer');
  const item = { id: 'w', state: 'claimed', owner: 'reviewer', leaseExpiresAt: null, title: 'w', files: [] };
  assert.throws(() => store.command(key, 'commons', { id: 'forged', type: 'work_claim.updated', data: workClaimEventData(item, 'claimed') }));
  const rows = store.db.prepare("SELECT body FROM events WHERE room_id=?").all('commons');
  assert.ok(!rows.some(({ body }) => JSON.parse(body).type === 'work_claim.updated'));
});

test('the claim path enforces the pilot event cap with the same refusal as the command path (#3699)', async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  t.after(() => store.close());
  const key = store.issueAccessKey('commons', 'owner');
  const item = { id: 'w', state: 'claimed', owner: 'owner', leaseExpiresAt: null, title: 'w', files: [] };
  const atCap = error => error.status === 409 && error.code === 'pilot_limit'
    && error.message === 'Bounded pilot capacity reached; no data was changed';
  // One below the cap the receipt still lands, at the cap sequence itself.
  store.db.prepare('UPDATE rooms SET sequence=? WHERE id=?').run(PILOT_LIMITS.eventsPerRoom - 1, 'commons');
  const receipt = emitWorkClaimEvent(store, 'commons', { actorId: 'owner', item, action: 'claimed' });
  assert.equal(receipt.sequence, PILOT_LIMITS.eventsPerRoom);
  // At the cap both append paths refuse identically; neither appends.
  assert.throws(() => store.command(key, 'commons', { id: 'cap-cmd', type: 'member.added',
    data: { memberId: 'late', displayName: 'Late', kind: 'human', permissions: [] } }), atCap);
  assert.throws(() => emitWorkClaimEvent(store, 'commons', { actorId: 'owner', item, action: 'claimed' }), atCap);
  assert.equal(store.room('commons').sequence, PILOT_LIMITS.eventsPerRoom, 'no event was appended past the cap');
});

test('a claim refused at the pilot event cap leaves no claim row and no event (#3699)', async t => {
  const { store, owner } = await fixture(t);
  const eventCount = () => store.db.prepare('SELECT count(*) AS n FROM events WHERE room_id=?').get('commons').n;
  const before = eventCount();
  store.db.prepare('UPDATE rooms SET sequence=? WHERE id=?').run(PILOT_LIMITS.eventsPerRoom, 'commons');
  await assert.rejects(owner.workClaimCreate({ id: 'past-cap', title: 'Past cap' }),
    error => error.status === 409 && error.code === 'pilot_limit');
  assert.equal(store.workClaims.get('commons', 'past-cap'), null, 'the refused claim was not recorded');
  assert.equal(eventCount(), before, 'no event was appended for the refused claim');
});

test('the claim-event cap exempts resolving transitions only (#3747)', async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  t.after(() => store.close());
  const base = { id: 'w', owner: 'owner', leaseExpiresAt: null, title: 'w', files: [] };
  const atCap = error => error.status === 409 && error.code === 'pilot_limit';
  store.db.prepare('UPDATE rooms SET sequence=? WHERE id=?').run(PILOT_LIMITS.eventsPerRoom, 'commons');
  // Exits land at the cap: each is a one-way end to a live claim, so a
  // capped room can still unwind every claim it has open.
  const exits = [
    { action: 'released', item: { ...base, state: 'unclaimed', owner: null } },
    { action: 'lease_expired', item: { ...base, state: 'unclaimed', owner: null } },
    { action: 'closed', item: { ...base, state: 'closed' }, reason: 'closed' },
    { action: 'pr_merged', item: { ...base, state: 'done' }, pullRequest: { url: 'https://github.com/Uuriko/project-room/pull/1' } },
    { action: 'pr_closed', item: { ...base, state: 'unclaimed', owner: null }, pullRequest: { url: 'https://github.com/Uuriko/project-room/pull/1' } },
    { action: 'state_changed', item: { ...base, state: 'done' } },
    // Unblocking: the row lands back in a live state, so only the
    // pre-transition state shows the transition was an exit.
    { action: 'state_changed', item: { ...base, state: 'in_progress' }, previousState: 'blocked' },
    // A card born already closed (superseding a never-accepted item).
    { action: 'created', item: { ...base, state: 'closed', supersededBy: 'wb_other' } },
  ];
  let sequence = PILOT_LIMITS.eventsPerRoom;
  for (const { action, item, ...extra } of exits) {
    const receipt = emitWorkClaimEvent(store, 'commons', { actorId: 'owner', item, action, ...extra });
    assert.equal(receipt.sequence, ++sequence, `${action} lands at capacity`);
  }
  // Growth and ordinary progress still refuse, and record nothing.
  const growth = [
    { action: 'created', item: { ...base, state: 'unclaimed', owner: null } },
    { action: 'claimed', item: { ...base, state: 'claimed' } },
    { action: 'renewed', item: { ...base, state: 'in_progress' } },
    { action: 'reviewed', item: { ...base, state: 'in_progress' } },
    { action: 'reassigned', item: { ...base, state: 'in_progress' } },
    { action: 'ci_changed', item: { ...base, state: 'in_progress' }, reason: 'ci_changed', ciState: 'success' },
    { action: 'state_changed', item: { ...base, state: 'in_progress' }, previousState: 'claimed' },
    { action: 'state_changed', item: { ...base, state: 'blocked' }, previousState: 'in_progress' },
  ];
  for (const { action, item, ...extra } of growth) {
    assert.throws(() => emitWorkClaimEvent(store, 'commons', { actorId: 'owner', item, action, ...extra }), atCap, `${action} refuses at capacity`);
  }
  assert.equal(store.room('commons').sequence, sequence, 'refusals appended nothing');
});

test('at the pilot event cap open claims can still be released, completed, expired and closed, while growth refuses (#3747)', async t => {
  const { store, owner, peer } = await fixture(t);
  // Open claims, all set up below the cap. The completion's review
  // ceremony also happens below the cap: verdicts are progress, not exits.
  await owner.workClaimCreate({ id: 'open', title: 'Open' });
  await owner.workClaim('held', { title: 'Held', files: ['docs/held.md'] });
  await owner.workClaim('lapsed', { title: 'Lapsed', leaseHours: 1 });
  await owner.workClaim('retire', { title: 'Retire' });
  await owner.workClaimCreate({ id: 'finish', title: 'Finish', reviewPolicy: 'distinct_member' });
  await owner.claimWorkItem('finish');
  await owner.updateWorkItem('finish', { state: 'in_progress' });
  await peer.reviewWorkItem('finish', { note: 'Checked the result' });
  await peer.reviewWorkItem('finish', { verdict: 'approve', summary: 'Approved' });
  store.db.prepare('UPDATE rooms SET sequence=? WHERE id=?').run(PILOT_LIMITS.eventsPerRoom, 'commons');
  const capped = error => error.status === 409 && error.code === 'pilot_limit';
  // Growth refuses and records nothing.
  await assert.rejects(owner.claimWorkItem('open'), capped);
  assert.equal((await owner.workClaimGet('open')).state, 'unclaimed');
  // Exits land: release, completion and close each end a live claim.
  const released = await owner.releaseWorkItem('held', { note: 'parked', ...roundOf(await owner.workClaimGet('held')) });
  assert.equal(released.state, 'unclaimed');
  const done = await owner.workComplete('finish', { reviewedBy: 'reviewer' });
  assert.equal(done.state, 'done');
  const closed = await owner.closeWorkClaim('retire', { verb: 'close', reason: 'no longer needed' });
  assert.equal(closed.state, 'closed');
  // The exits did not reopen growth.
  await assert.rejects(owner.claimWorkItem('open'), capped);
  // Expiry still fires: backdate the lease and let a board read sweep it.
  const row = store.workClaims.get('commons', 'lapsed');
  store.workClaims.set('commons', { ...row, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  await owner.workClaims();
  assert.equal((await owner.workClaimGet('lapsed')).state, 'unclaimed');
  const expired = (await claimEvents(owner)).filter(e => e.action === 'lease_expired' && e.workClaim === 'lapsed');
  assert.equal(expired.length, 1);
});

test('the event payload refuses an action the reducer does not know', () => {
  const item = { id: 'w', state: 'claimed', owner: 'a', leaseExpiresAt: null, title: 'w', files: [] };
  assert.throws(() => workClaimEventData(item, 'teleported'), /Unknown work claim action/);
  assert.throws(() => applyEvent(emptyRoomState(), {
    id: 'e1', idempotencyKey: 'k1', roomId: 'commons', type: 'work_claim.updated', actorId: 'owner', at: new Date().toISOString(),
    data: { ...workClaimEventData(item, 'claimed'), action: 'teleported' }
  }));
});
