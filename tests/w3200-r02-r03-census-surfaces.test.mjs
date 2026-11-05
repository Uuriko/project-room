// WAVE-3200 cohort 02, lane-03 — R-02 (reply reader) and R-03 ('@'-post
// command context + DM consent) against rooms whose TOTAL member records
// exceed 100 while ACTIVE members stay within the 100-member pilot cap
// (CENSUS-DESIGN, lanes/lane-01/DESIGN.md §3.2/§3.3).
//
// R-02 falsifier: in a >=95-member (here 101 total) current-format room,
// readCurrentReplies list mode returns a page instead of 409.
// R-03 falsifiers: in the same room shape, (a) a message.posted command
// whose body contains '@' completes instead of 409, and (b) a DM-consent
// request/decide completes instead of 409 — while a room with >100 ACTIVE
// members still refuses with the identical 409 shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {readCurrentHead, readCurrentRecord, withCurrentReadContext} from '../server/current-room-repository.mjs';

const memberId = (i) => `mem-${String(i).padStart(3, '0')}`;

// owner + 100 added members = 101 total records; the last `deactivated`
// are switched off, leaving 101 - deactivated active members.
function bigRoom(t, {deactivated = 5} = {}) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const events = initialRoom();
  const add = (type, data, actorId = 'owner') => events.push(event({roomId: 'commons', actorId, type, data}));
  for (let i = 1; i <= 100; i++) add('member.added', {memberId: memberId(i), displayName: `Member ${String(i).padStart(3, '0')}`, kind: 'agent', permissions: []});
  for (let i = 100 - deactivated + 1; i <= 100; i++) add('member.access_changed', {memberId: memberId(i), expectedMemberRevision: 0, permissions: [], active: false});
  add('message.posted', {messageId: 'req-1', toMemberId: memberId(2), requestKind: 'reply', requestPolicyVersion: 1, body: 'Please review the plan'}, memberId(1));
  store.initialize(events, {representation: 'normalized-current-v1'});
  const key = (id) => store.issueAccessKey('commons', id);
  return {store, key};
}

test('R-02: reply list returns a page in a 101-total-member current room', (t) => {
  const {store, key} = bigRoom(t);
  const listed = store.replyRequests.list(key(memberId(2)), 'commons', {direction: 'incoming', status: 'open'});
  assert.deepEqual(listed.requests.map((request) => request.id), ['req-1']);
});

test("R-03: '@'-post command completes in a 101-total / 96-active current room", (t) => {
  const {store, key} = bigRoom(t);
  const result = store.command(key('owner'), 'commons', {id: 'at-post-1', type: 'message.posted', data: {messageId: 'at-post-1', body: 'Coordination ping @Member 002 — please look'}});
  assert.ok(result);
  assert.equal(store.headSequence('commons') > 0, true);
});

test('R-03: DM-consent request and decide complete in a 101-total / 96-active current room', (t) => {
  const {store} = bigRoom(t);
  assert.equal(store.dmConsents.request('commons', memberId(1), memberId(2), 'Coordinate on the plan').status, 'pending');
  assert.equal(store.dmConsents.pendingFor('commons', memberId(2))[0].requesterId, memberId(1));
  assert.equal(store.dmConsents.decide('commons', memberId(2), memberId(1), 'approve').status, 'approved');
});

test('R-03: roster reads and consent writes never tombstone or resurrect deactivated records (DESIGN §2.3 case)', (t) => {
  const {store, key} = bigRoom(t);
  store.command(key('owner'), 'commons', {id: 'at-post-2', type: 'message.posted', data: {messageId: 'at-post-2', body: 'Status @Member 001'}});
  store.dmConsents.request('commons', memberId(1), memberId(2), 'Coordinate');
  const probe = withCurrentReadContext(store.db, 'commons', (b) => {
    const head = readCurrentHead(store.db, 'commons', b);
    const gone = readCurrentRecord(store.db, 'commons', 'members', memberId(100), b);
    return {total: head.counts.members, deactivated: gone};
  });
  assert.equal(probe.total, 101);
  assert.ok(probe.deactivated, 'deactivated member record must still exist');
  assert.equal(probe.deactivated.active, false);
});

test('R-03: pattern-(b) views (owner list, pendingFor) work in the 101-total room', (t) => {
  const {store} = bigRoom(t);
  store.dmConsents.request('commons', memberId(1), memberId(2), 'Coordinate on the plan');
  const pending = store.dmConsents.pendingFor('commons', memberId(2));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requesterId, memberId(1));
  assert.equal(pending[0].requester, 'Member 001');
  const ownerList = store.dmConsents.list('commons', 'owner');
  assert.equal(ownerList.length, 1);
  assert.equal(ownerList[0].requester, 'Member 001');
  assert.equal(ownerList[0].target, 'Member 002');
});

test('refusal preserved: >100 ACTIVE members still refuse the roster read with the identical 409', (t) => {
  const {store, key} = bigRoom(t, {deactivated: 0});
  // 101 active members (owner + 100): the bounded-membership refusal stands.
  assert.throws(
    () => store.command(key('owner'), 'commons', {id: 'at-post-x', type: 'message.posted', data: {messageId: 'at-post-x', body: 'ping @Member 002'}}),
    (error) => error.status === 409 && error.code === 'current_room_context_unavailable' && /bounded membership/.test(error.message),
  );
});
