// W3200 R-01: churn bricks presence. Admission gates count ACTIVE members
// (PILOT_LIMITS.membersPerRoom = 100 active), but the current-format census
// behind store.presence() counted TOTAL member records including deactivated
// ones and refused at >100 total. A churn-heavy room (members joined, later
// deactivated, replaced) therefore lost presence/roster entirely while
// addressed reads still worked, with no in-product recovery.
//
// Fixture: 106 total member records, 10 deactivated -> 96 active (<= the
// 100-active cap). Presence must answer with exactly the active roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';

function churnedRoom(t, {added = 105, deactivated = 10} = {}) {
  const s = new RoomStore(':memory:');
  t.after(() => s.close());
  const es = initialRoom();
  const add = (type, data, actorId = 'owner') => es.push(event({roomId: 'commons', actorId, type, data}));
  const ids = Array.from({length: added}, (_, i) => 'member-' + i);
  for (const id of ids) add('member.added', {memberId: id, displayName: id, kind: 'agent', permissions: []});
  for (const id of ids.slice(0, deactivated)) {
    add('member.access_changed', {memberId: id, expectedMemberRevision: 0, permissions: [], active: false});
  }
  s.initialize(es, {representation: 'normalized-current-v1'});
  const ownerKey = s.issueAccessKey('commons', 'owner');
  return {s, ownerKey, ids};
}

test('presence answers in a churned room past 101 total records with <=100 active members', t => {
  const {s, ownerKey, ids} = churnedRoom(t);
  const report = s.presence(ownerKey, 'commons', []);
  assert.equal(report.members.length, 96); // owner + 95 still-active added members
  const listed = new Set(report.members.map(m => m.memberId));
  assert.ok(listed.has('owner'));
  for (const id of ids.slice(0, 10)) assert.ok(!listed.has(id), `deactivated ${id} must not be listed`);
  for (const id of ids.slice(10)) assert.ok(listed.has(id), `active ${id} must be listed`);
  assert.equal(report.coverage.membership, 'complete-current-roster');
});

test('presence still answers at exactly 100 active members with deactivated records beyond', t => {
  const {s, ownerKey} = churnedRoom(t, {added: 109, deactivated: 10});
  const report = s.presence(ownerKey, 'commons', []);
  assert.equal(report.members.length, 100);
});
