// C5 DB/index hygiene: query-plan contracts.
//
// Fail-first: each plan assertion fails on the unindexed schema and passes
// once the covering index exists. These pin the query shapes the server
// actually runs (copied from server/needs-me.mjs roomDmsOf and
// server/claim-reputation.mjs), so an index rename or a rewritten predicate
// breaks loudly instead of silently reintroducing a scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import {
  syncClaimReputationJournal,
  readRoomClaimUpdatedEvents,
  CLAIM_UPDATED_EVENTS_SQL,
} from '../server/claim-reputation.mjs';

const planOf = (db, sql, params) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join(' | ');

// Exact query shape from server/needs-me.mjs roomDmsOf (the needs-me DM poll).
const ROOM_DMS_SQL = `SELECT sequence, body FROM events
     WHERE room_id=? AND sequence>? AND json_extract(body,'$.type')='message.posted'
       AND json_extract(body,'$.data.toMemberId')=?
     ORDER BY sequence ASC LIMIT 9`;

function seedRoom(db, roomId, bodies) {
  db.prepare('INSERT INTO rooms(id, sequence, projection) VALUES(?,?,?)')
    .run(roomId, bodies.length, JSON.stringify({ room: { id: roomId } }));
  const ins = db.prepare('INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)');
  bodies.forEach((body, i) => ins.run(roomId, i + 1, body.id ?? `${roomId}-e${i + 1}`, JSON.stringify(body)));
}

const posted = (id, data, actorId = 'm-bob') => ({
  id, type: 'message.posted', at: new Date(Date.now()).toISOString(), actorId, data,
});

test('roomDmsOf uses the events_dm_to_member partial index, never a scan', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const db = store.db;
  const found = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='events_dm_to_member'").get();
  assert.ok(found, 'events_dm_to_member index must exist');
  seedRoom(db, 'dm-room', [
    posted('e1', { messageId: 'e1', body: 'public one' }),
    posted('e2', { messageId: 'e2', body: 'dm for ada', toMemberId: 'm-ada' }),
    posted('e3', { messageId: 'e3', body: 'public two' }),
    posted('e4', { messageId: 'e4', body: 'dm for bob', toMemberId: 'm-bob' }),
  ]);
  const plan = planOf(db, ROOM_DMS_SQL, ['dm-room', 0, 'm-ada']);
  assert.match(plan, /events_dm_to_member/, `plan must use the DM index, got: ${plan}`);
  assert.doesNotMatch(plan, /SCAN/, `plan must not scan, got: ${plan}`);
  // The index must not change what the query returns.
  const rows = db.prepare(ROOM_DMS_SQL).all('dm-room', 0, 'm-ada');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sequence, 2);
});

const claimUpdated = (id, data, actorId = 'lane-a') => ({
  id, type: 'work_claim.updated', at: new Date(Date.now()).toISOString(), actorId, data,
});

function seedClaimRooms(db) {
  seedRoom(db, 'rep-room-a', [
    posted('a-noise', { messageId: 'a-noise', body: 'chatter' }),
    claimUpdated('a-c1', { workClaim: 'c1', action: 'claimed', ownerId: 'lane-a' }),
    claimUpdated('a-c2', { workClaim: 'c1', action: 'state_changed', claimState: 'done', ownerId: 'lane-a' }),
  ]);
  seedRoom(db, 'rep-room-b', [
    claimUpdated('b-c1', { workClaim: 'c2', action: 'claimed', ownerId: 'lane-b' }),
    posted('b-noise', { messageId: 'b-noise', body: 'chatter' }),
  ]);
}

test('claim-reputation journal reads never scan the events table', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const db = store.db;
  seedClaimRooms(db);
  const plan = planOf(db, CLAIM_UPDATED_EVENTS_SQL, ['rep-room-a']);
  // Room-scoped read pinned to the expression index: a seek, never a scan.
  // (Without INDEXED BY the planner prefers the room_id PK slice and
  // re-scans every event in the room.)
  assert.match(plan, /events_room_type/, `plan must use events_room_type, got: ${plan}`);
  assert.doesNotMatch(plan, /SCAN/, `plan must not scan, got: ${plan}`);
  const rows = readRoomClaimUpdatedEvents(db, 'rep-room-a');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.sequence), [2, 3]);
});

test('claim-reputation all-rooms sync folds per room with identical signals', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const db = store.db;
  seedClaimRooms(db);
  const result = syncClaimReputationJournal(db, {});
  assert.equal(result.eventsRead, 3);
  assert.equal(result.signalsDerived, 1);
  assert.equal(result.signalsWritten, 1);
  assert.equal(result.legacyRowsRemoved, 0);
  assert.equal(result.widenedToAllRooms, false);
  const signals = db.prepare(
    'SELECT claim_id, kind, agent_id, room_id FROM claim_reputation_signals ORDER BY id').all()
    .map(row => ({ claim_id: row.claim_id, kind: row.kind, agent_id: row.agent_id, room_id: row.room_id }));
  assert.deepEqual(signals, [
    { claim_id: 'c1', kind: 'claim_completed', agent_id: 'lane-a', room_id: 'rep-room-a' },
  ]);
  // Idempotent: a second full sync writes nothing new.
  const again = syncClaimReputationJournal(db, {});
  assert.equal(again.signalsWritten, 0);
  assert.equal(again.eventsRead, 3);
});
