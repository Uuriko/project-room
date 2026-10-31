// Pool F (fleet wave 2026-10-31, lane F1): archived-room freeze coverage
// for the MODERATION surface (T3-L10c-C10 in the line-by-line audit).
//
// The freeze in PR #5502 lives at the store / side-table write layer: one
// shared guard (server/archived-guard.mjs, plus refuseArchivedWrite from
// server/room-lifecycle.mjs) called at each covered module's write-entry
// choke point. Moderation reports never pass through store.command():
// Moderation.report (server/moderation.mjs) authenticates directly and
// INSERTs into message_reports inside its own transaction. This file
// proves, by execution, whether filing a report in an archived room is
// refused 409 room_archived once #5502's guard is in place, and that no
// report row is recorded when it is.
//
// Falsifier: the archived-room test below fails on plain main (the report
// lands and the row persists) and must pass on the #5502-stacked head if
// the surface is covered. The live-room control proves the report path
// itself works, so a refusal can only be the freeze.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

const isArchivedRefusal = error => error?.status === 409 && error?.code === 'room_archived';

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const keys = { owner: ownerKey };
  for (const memberId of ['producer', 'guest']) {
    store.command(ownerKey, 'commons', { id: `add-${memberId}`, type: 'member.added',
      data: { memberId, displayName: `Test ${memberId}`, kind: 'human', permissions: [] } });
    keys[memberId] = store.issueAccessKey('commons', memberId);
  }
  store.command(keys.producer, 'commons', { id: 'post-1', type: 'message.posted',
    data: { messageId: 'target', body: 'a message worth reporting' } });
  t.after(() => store.close());
  const archive = () => store.command(ownerKey, 'commons', { id: 'archive-room', type: 'room.archived', data: { reason: 'pilot over' } });
  const reportCount = () => store.db.prepare("SELECT count(*) AS n FROM message_reports WHERE room_id='commons'").get().n;
  return { store, keys, archive, reportCount };
}

test('control: a moderation report succeeds in a room that is not archived', t => {
  const { store, keys, reportCount } = fixture(t);
  const result = store.moderation.report(keys.guest, 'commons', { messageId: 'target', reason: 'Off-topic and repeated.' });
  assert.equal(result.duplicate, false);
  assert.equal(reportCount(), 1);
});

test('moderation report in an archived room refuses 409 room_archived and records nothing', t => {
  const { store, keys, archive, reportCount } = fixture(t);
  archive();
  assert.throws(() => store.moderation.report(keys.guest, 'commons', { messageId: 'target', reason: 'Off-topic and repeated.' }),
    isArchivedRefusal, 'filing a report in an archived room must refuse 409 room_archived');
  assert.equal(reportCount(), 0, 'the refused report was not recorded');
  // Reads still work in the archived room.
  assert.deepEqual(store.moderation.list(keys.owner, 'commons').reports, [],
    'report list still answers in an archived room');
});
