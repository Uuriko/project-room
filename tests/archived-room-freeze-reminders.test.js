// Pool F (fleet wave 2026-10-31, lane F1): archived-room freeze coverage
// for the REMINDERS surface (T3-L10f-C2 in the line-by-line audit).
//
// The freeze in PR #5502 lives at the store / side-table write layer: one
// shared guard (server/archived-guard.mjs, plus refuseArchivedWrite from
// server/room-lifecycle.mjs) called at each covered module's write-entry
// choke point. Reminder writes never pass through store.command():
// Reminders.mutate (server/reminders.mjs) authenticates directly and
// writes private_reminders + private_reminder_commands inside its own
// transaction. This file proves, by execution, whether scheduling or
// cancelling a reminder in an archived room is refused 409
// room_archived once #5502's guard is in place, and that no reminder row
// or receipt is recorded when it is.
//
// Falsifier: the archived-room test below fails on plain main (the write
// lands and the rows persist) and must pass on the #5502-stacked head if
// the surface is covered. The live-room control proves the reminder path
// itself works, so a refusal can only be the freeze.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

const isArchivedRefusal = error => error?.status === 409 && error?.code === 'room_archived';

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'propose-1', type: 'work.proposed',
    data: { workItemId: 'w1', title: 'Handoff', definitionOfDone: 'Done', accountableMemberId: 'owner', mode: 'read' } });
  t.after(() => store.close());
  const archive = () => store.command(ownerKey, 'commons', { id: 'archive-room', type: 'room.archived', data: { reason: 'pilot over' } });
  const schedule = (expectedRevision = 0) => ({ requestId: randomUUID(), workItemId: 'w1',
    expectedRevision, action: 'schedule', dueAt: Date.now() + 3600000 });
  const cancel = expectedRevision => ({ requestId: randomUUID(), workItemId: 'w1', expectedRevision, action: 'cancel' });
  const counts = () => ({
    reminders: store.db.prepare("SELECT count(*) AS n FROM private_reminders WHERE room_id='commons'").get().n,
    receipts: store.db.prepare("SELECT count(*) AS n FROM private_reminder_commands WHERE room_id='commons'").get().n,
  });
  return { store, ownerKey, archive, schedule, cancel, counts };
}

test('control: scheduling and cancelling a reminder succeed in a room that is not archived', t => {
  const { store, ownerKey, schedule, cancel, counts } = fixture(t);
  const scheduled = store.reminders.mutate(ownerKey, 'commons', schedule());
  assert.equal(scheduled.receipt.state, 'active');
  const cancelled = store.reminders.mutate(ownerKey, 'commons', cancel(1));
  assert.equal(cancelled.receipt.state, 'cancelled');
  assert.deepEqual(counts(), { reminders: 1, receipts: 2 });
});

test('reminder schedule and cancel in an archived room refuse 409 room_archived and record nothing new', t => {
  const { store, ownerKey, archive, schedule, cancel, counts } = fixture(t);
  const scheduled = store.reminders.mutate(ownerKey, 'commons', schedule());
  assert.equal(scheduled.receipt.state, 'active');
  archive();
  assert.throws(() => store.reminders.mutate(ownerKey, 'commons', schedule(1)),
    isArchivedRefusal, 'scheduling a reminder in an archived room must refuse 409 room_archived');
  assert.throws(() => store.reminders.mutate(ownerKey, 'commons', cancel(1)),
    isArchivedRefusal, 'cancelling a reminder in an archived room must refuse 409 room_archived');
  assert.deepEqual(counts(), { reminders: 1, receipts: 1 },
    'only the pre-archive reminder and its receipt exist');
  assert.equal(store.reminders.list(ownerKey, 'commons').reminders[0].state, 'active',
    'the pre-archive reminder is unchanged and still reads back');
});
