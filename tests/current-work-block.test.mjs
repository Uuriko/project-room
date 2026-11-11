import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';
import {readCurrentWorkListing} from '../server/current-work-list.mjs';

// work.blocked / work.blocker_resolved were refused on normalized rooms
// ("no qualified current-record dependency plan"), so no agent could report
// a blocker there. They need the same task + actor records as a handoff.
function fixture(t) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const es = initialRoom();
  for (const id of ['worker', 'other']) es.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: id, displayName: id, kind: 'agent', permissions: ['accept_work', 'complete_work']}}));
  s.initialize(es, {representation: 'normalized-current-v1'});
  const keys = Object.fromEntries(['owner', 'worker', 'other'].map(id => [id, s.issueAccessKey('commons', id)]));
  s.room = () => { throw Error('full room hydration'); };
  const cmd = (who, id, type, data) => s.command(keys[who], 'commons', {id, type, data});
  cmd('owner', 'propose', 'work.proposed', {workItemId: 'task', title: 'Original task', definitionOfDone: 'Saved result', accountableMemberId: 'worker', mode: 'read'});
  cmd('worker', 'accept', 'work.accepted', {workItemId: 'task', expectedRevision: 0});
  const item = () => JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE work_id='task'").get().body);
  return {s, keys, cmd, item};
}
const rows = s => Object.fromEntries(['events', 'commands', 'work_entities', 'current_room_records', 'current_room_record_proofs'].map(table => [table, s.db.prepare('SELECT * FROM ' + table).all()]));

test('normalized rooms record a blocker, refuse the wrong actor, retry exactly and resolve it', t => {
  const {s, keys, cmd, item} = fixture(t);
  const before = rows(s);
  assert.throws(() => cmd('other', 'wrong-actor', 'work.blocked', {workItemId: 'task', reason: 'x', nextAction: 'x'}), /accountable/);
  assert.throws(() => cmd('worker', 'missing', 'work.blocked', {workItemId: 'task', reason: 'Waiting on storage OK'}), /nextAction/);
  assert.deepEqual(rows(s), before, 'refusals write nothing');
  const data = {workItemId: 'task', expectedRevision: item().revision, reason: 'Waiting on storage OK', nextAction: 'Root approves the event'};
  const blocked = cmd('worker', 'block', 'work.blocked', data);
  assert.equal(item().state, 'blocked');
  assert.deepEqual(item().blocker, {reason: 'Waiting on storage OK', nextAction: 'Root approves the event', eventId: blocked.event.id});
  const after = rows(s);
  assert.equal(s.command(keys.worker, 'commons', {id: 'block', type: 'work.blocked', data}).duplicate, true);
  assert.deepEqual(rows(s), after, 'exact retry is a duplicate');
  assert.throws(() => cmd('other', 'wrong-resolver', 'work.blocker_resolved', {workItemId: 'task', resolution: 'x'}), /accountable/);
  cmd('worker', 'resolve', 'work.blocker_resolved', {workItemId: 'task', expectedRevision: item().revision, resolution: 'Root approved'});
  assert.equal(item().state, 'accepted');
  assert.equal(item().blocker, null);
  cmd('worker', 'start', 'work.started', {workItemId: 'task', expectedRevision: item().revision});
  assert.equal(item().state, 'working');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM work_entities').get().n, 1);
  assert.doesNotThrow(() => auditRecovery(s));
});

test('a blocked normalized task stays on the bounded needs-me listing as revise', t => {
  const {s, keys, cmd, item} = fixture(t);
  cmd('worker', 'block', 'work.blocked', {workItemId: 'task', expectedRevision: item().revision, reason: 'Waiting', nextAction: 'Unblock'});
  const listing = readCurrentWorkListing(s, keys.worker, 'commons', {focus: 'needs_me'});
  const row = listing.work.find(entry => entry.id === 'task');
  assert.equal(row?.state, 'blocked', JSON.stringify(listing.work));
  assert.equal(row.next.action, 'revise');
  assert.equal(row.next.memberId, 'worker');
  assert.doesNotThrow(() => auditRecovery(s));
});
