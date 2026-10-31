// Pool F (fleet wave 2026-10-31, lane F1): archived-room freeze coverage
// for the TALK-POLICY surface (T3-L02-C4 in the line-by-line audit).
//
// The freeze in PR #5502 lives at the store / side-table write layer: one
// shared guard (server/archived-guard.mjs, plus refuseArchivedWrite from
// server/room-lifecycle.mjs) called at each covered module's write-entry
// choke point. Talk-policy writes never pass through store.command():
// store.setTalkPolicy authenticates and goes straight into
// writeTalkPolicy (server/agent-talk-policy.mjs), which INSERTs into
// agent_talk_policies. This file proves, by execution, whether a
// talk-policy write into an archived room is refused 409 room_archived
// once #5502's guard is in place, and that nothing is recorded when it is.
//
// Falsifier: the archived-room test below fails on plain main (the write
// lands and the row persists) and must pass on the #5502-stacked head if
// the surface is covered. The live-room control proves the write path
// itself works, so a refusal can only be the freeze.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readTalkPolicy } from '../server/agent-talk-policy.mjs';

const isArchivedRefusal = error => error?.status === 409 && error?.code === 'room_archived';

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-bot', type: 'member.added',
    data: { memberId: 'bot', displayName: 'Bot', kind: 'agent', accountableHumanId: 'owner', permissions: [] } });
  t.after(() => store.close());
  const archive = () => store.command(ownerKey, 'commons', { id: 'archive-room', type: 'room.archived', data: { reason: 'pilot over' } });
  return { store, ownerKey, archive };
}

test('control: a talk-policy write succeeds in a room that is not archived', t => {
  const { store, ownerKey } = fixture(t);
  const set = store.setTalkPolicy(ownerKey, 'commons', 'bot', { policy: 'nobody' });
  assert.equal(set.policy, 'nobody');
  assert.equal(readTalkPolicy(store.db, 'commons', 'bot').policy, 'nobody');
});

test('talk-policy write in an archived room refuses 409 room_archived and records nothing', t => {
  const { store, ownerKey, archive } = fixture(t);
  // Set a distinctive live policy before archiving so a post-archive write
  // that lands is visible as a changed row, not just a present one.
  store.setTalkPolicy(ownerKey, 'commons', 'bot', { policy: 'room' });
  archive();
  assert.throws(() => store.setTalkPolicy(ownerKey, 'commons', 'bot', { policy: 'nobody' }),
    isArchivedRefusal, 'talk-policy write in an archived room must refuse 409 room_archived');
  assert.equal(readTalkPolicy(store.db, 'commons', 'bot').policy, 'room',
    'the pre-archive talk policy is unchanged by the refused write');
  // Reads still work in the archived room.
  assert.equal(store.talkPolicy(ownerKey, 'commons', 'bot').policy, 'room',
    'talk-policy read still answers in an archived room');
});
