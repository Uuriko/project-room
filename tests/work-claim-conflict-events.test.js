// FIX-34: a failed claim attempt must leave an observable signal. Cross-guild
// contention over the same work used to be invisible by construction — zero
// conflict events existed in any room log — so duplicate work was discovered
// only as duplicate PRs. Every 409 refusal on a claim attempt (and on board
// cap refusals) now appends one cheap `work_claim.updated` event with action
// `conflict_attempted` naming the task, the would-be claimer, the current
// holder, and the refusal code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { handleWorkClaims } from '../server/work-claim-routes.mjs';

const PEER_PERMISSIONS = ['accept_work', 'complete_work'];

async function fixture(t, configure = null) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  for (const memberId of ['peer', 'peer2']) {
    store.command(ownerKey, 'commons', { id: `add-${memberId}`, type: 'member.added',
      data: { memberId, displayName: memberId, kind: 'agent', permissions: PEER_PERMISSIONS } });
  }
  if (configure) store.workClaims.configure('commons', configure);
  const call = ({ member = 'owner', route, claimId, body = {} }) =>
    handleWorkClaims({
      req: { method: 'POST' }, res: {}, url: new URL('http://localhost'),
      store, roomId: 'commons',
      auth: { member: { id: member, kind: member === 'owner' ? 'human' : 'agent' } },
      workClaimRoute: route, workClaimId: claimId, registry: store.workClaims,
      helpers: {
        body: async () => body,
        json: (_res, status, value) => ({ status, value }),
        reject: (status, code, message) => {
          const e = new Error(message); e.status = status; e.code = code;
          e.body = { error: { code, message } };
          throw e;
        },
      },
    });
  const conflicts = () => store.db.prepare(
    "SELECT sequence, body FROM events WHERE room_id=? ORDER BY sequence").all('commons')
    .map(({ sequence, body }) => ({ sequence, ...JSON.parse(body) }))
    .filter(event => event.type === 'work_claim.updated' && event.data?.action === 'conflict_attempted');
  return { store, call, conflicts };
}

test('a 409 claim conflict emits one conflict_attempted event naming task, claimer, holder, code', async t => {
  const { store, call, conflicts } = await fixture(t);
  assert.equal((await call({ route: 'create', body: { id: 'contended', title: 'Contended' } })).status, 201);
  assert.equal((await call({ route: 'claim', claimId: 'contended', body: { leaseHours: 1 } })).status, 200);
  const attempt = await call({ route: 'claim', claimId: 'contended', member: 'peer', body: { leaseHours: 1 } }).catch(e => e);
  assert.equal(attempt.status, 409);
  assert.equal(attempt.code, 'work_claim_conflict');
  const events = conflicts();
  assert.equal(events.length, 1);
  const data = events[0].data;
  assert.equal(data.workClaim, 'contended');
  assert.equal(data.action, 'conflict_attempted');
  assert.equal(data.conflictCode, 'work_claim_conflict');
  assert.equal(data.requesterId, 'peer');
  assert.equal(data.ownerId, 'owner');
  assert.equal(data.claimState, 'claimed');
  assert.deepEqual(data.paths, []);
  assert.ok(typeof events[0].at === 'string' && !Number.isNaN(Date.parse(events[0].at)), 'carries a timestamp');
  assert.equal(events[0].actorId, 'peer', 'the event is attributed to the would-be claimer');
  const claimedSeq = store.db.prepare(
    "SELECT sequence FROM events WHERE room_id=?").all('commons').length;
  assert.ok(events[0].sequence <= claimedSeq, 'the conflict event carries a server sequence');
});

test('a self re-claim 409 also emits, with holder equal to the requester', async t => {
  const { call, conflicts } = await fixture(t);
  await call({ route: 'create', body: { id: 'mine' } });
  await call({ route: 'claim', claimId: 'mine', body: { leaseHours: 1 } });
  const attempt = await call({ route: 'claim', claimId: 'mine', body: { leaseHours: 1 } }).catch(e => e);
  assert.equal(attempt.status, 409);
  assert.equal(attempt.code, 'work_claim_conflict');
  const events = conflicts();
  assert.equal(events.length, 1);
  assert.equal(events[0].data.conflictCode, 'work_claim_conflict');
  assert.equal(events[0].data.requesterId, 'owner');
  assert.equal(events[0].data.ownerId, 'owner');
});

test('a work_board_full refusal emits a conflict event with no holder', async t => {
  const { call, conflicts } = await fixture(t, { maxOpenClaims: 1 });
  assert.equal((await call({ route: 'create', body: { id: 'first' } })).status, 201);
  const attempt = await call({ route: 'create', body: { id: 'second' } });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.value.error.code, 'work_board_full');
  const events = conflicts();
  assert.equal(events.length, 1);
  assert.equal(events[0].data.workClaim, 'second');
  assert.equal(events[0].data.conflictCode, 'work_board_full');
  assert.equal(events[0].data.requesterId, 'owner');
  assert.equal(events[0].data.ownerId, null);
  assert.equal(events[0].data.claimState, 'unclaimed');
});

test('a too_many_open_claims refusal emits a conflict event naming the capped member', async t => {
  const { call, conflicts } = await fixture(t, { maxMemberOpenClaims: 1 });
  assert.equal((await call({ route: 'create', body: { id: 'a' } })).status, 201);
  assert.equal((await call({ route: 'claim', claimId: 'a', body: { leaseHours: 1 } })).status, 200);
  assert.equal((await call({ route: 'create', body: { id: 'b' } })).status, 201);
  const attempt = await call({ route: 'claim', claimId: 'b', body: { leaseHours: 1 } });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.value.error.code, 'too_many_open_claims');
  const events = conflicts();
  assert.equal(events.length, 1);
  assert.equal(events[0].data.workClaim, 'b');
  assert.equal(events[0].data.conflictCode, 'too_many_open_claims');
  assert.equal(events[0].data.requesterId, 'owner');
  assert.equal(events[0].data.ownerId, 'owner');
});

test('a file_lease_conflict emits a conflict event naming the lease holder', async t => {
  const { call, conflicts } = await fixture(t);
  assert.equal((await call({ route: 'create', body: { id: 'lane-a', files: ['server/shared.mjs'] } })).status, 201);
  assert.equal((await call({ route: 'claim', claimId: 'lane-a', body: { leaseHours: 1 } })).status, 200);
  assert.equal((await call({ route: 'create', member: 'peer', body: { id: 'lane-b' } })).status, 201);
  const attempt = await call({ route: 'claim', claimId: 'lane-b', member: 'peer', body: { leaseHours: 1, files: ['server/shared.mjs'] } });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.value.error.code, 'file_lease_conflict');
  const events = conflicts();
  assert.equal(events.length, 1);
  assert.equal(events[0].data.workClaim, 'lane-b');
  assert.equal(events[0].data.conflictCode, 'file_lease_conflict');
  assert.equal(events[0].data.requesterId, 'peer');
  assert.equal(events[0].data.ownerId, 'owner');
});

test('no double emission: same requestId retries emit once; distinct requesters each get one', async t => {
  const { call, conflicts } = await fixture(t);
  await call({ route: 'create', body: { id: 'hot' } });
  await call({ route: 'claim', claimId: 'hot', body: { leaseHours: 1 } });
  const attempt = member => call({ route: 'claim', claimId: 'hot', member, body: { leaseHours: 1, requestId: 'retry-1' } }).catch(e => e);
  assert.equal((await attempt('peer')).status, 409);
  assert.equal((await attempt('peer')).status, 409, 'same requestId retried');
  assert.equal(conflicts().length, 1, 'one event for the repeated requestId');
  const other = await call({ route: 'claim', claimId: 'hot', member: 'peer', body: { leaseHours: 1, requestId: 'retry-2' } }).catch(e => e);
  assert.equal(other.status, 409);
  assert.equal(conflicts().length, 1, 'a different requestId inside the window still coalesces');
  const rival = await call({ route: 'claim', claimId: 'hot', member: 'peer2', body: { leaseHours: 1 } }).catch(e => e);
  assert.equal(rival.status, 409);
  const events = conflicts();
  assert.equal(events.length, 2, 'a second would-be claimer gets their own signal');
  assert.deepEqual(events.map(e => e.data.requesterId), ['peer', 'peer2']);
  assert.equal(events[0].data.requestId, 'retry-1', 'the requestId rides the payload for traceability');
});

test('a registry-only store still refuses cleanly without emitting', async t => {
  // Handler unit tests drive the routes with a registry-only store; a store
  // without an event log must refuse without recording anything.
  const { createWorkClaimRegistry } = await import('../server/work-claim-routes.mjs');
  const registry = createWorkClaimRegistry();
  const fakeStore = { roomAuthority: () => ({ members: {
    quill: { id: 'quill', kind: 'agent', active: true, permissions: ['accept_work', 'complete_work'] },
    grok: { id: 'grok', kind: 'agent', active: true, permissions: ['accept_work', 'complete_work'] },
  } }) };
  const runRoute = ({ route, id, body = {}, memberId = 'quill' }) => handleWorkClaims({
    req: { method: 'POST' }, res: {}, url: new URL('http://localhost'), roomId: 'room1',
    store: fakeStore, auth: { member: { id: memberId, kind: 'agent' } },
    workClaimRoute: route, workClaimId: id, registry,
    helpers: {
      body: async () => body,
      json: (_res, status, value) => ({ status, value }),
      reject: (status, code, message) => {
        const e = new Error(message); e.status = status; e.code = code;
        e.body = { error: { code, message } };
        throw e;
      },
    },
  });
  await runRoute({ route: 'create', body: { id: 'h4' } });
  await runRoute({ route: 'claim', id: 'h4' });
  const error = await runRoute({ route: 'claim', id: 'h4', memberId: 'grok' }).catch(e => e);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'work_claim_conflict');
});
