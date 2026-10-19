import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { migrateMessageReplaySnapshots, readMessageReplaySnapshot, writeMessageReplaySnapshot, decodeMessageReplaySnapshot, discardMessageReplaySnapshot } from '../server/message-replay-snapshot.mjs';

function legacyDatabase(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // Deployed schema38's replay cursor and chunk rows, before the schema42 split.
  db.exec(`CREATE TABLE rooms(id TEXT PRIMARY KEY);
    INSERT INTO rooms VALUES ('room');
    CREATE TABLE events(room_id TEXT,sequence INTEGER,id TEXT);
    INSERT INTO events VALUES ('room',12,'event-12');
    CREATE TABLE messages_backfill_cursor(room_id TEXT PRIMARY KEY,applied_seq INTEGER NOT NULL,
      applied_event_id TEXT NOT NULL DEFAULT '',state_seq INTEGER NOT NULL DEFAULT 0,
      state_json TEXT,parity_at_seq INTEGER,sweep_after TEXT NOT NULL DEFAULT '');
    CREATE TABLE messages_backfill_state(room_id TEXT NOT NULL,part INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(room_id,part));`);
  return db;
}
const decode = db => decodeMessageReplaySnapshot(db,'room',readMessageReplaySnapshot(db,'room').state_json);

test('deployed chunked snapshot migrates without changing certification or losing its anchor',t => {
  const db = legacyDatabase(t);
  const state = {messages:[{id:'m',body:'migration text 😀'.repeat(50000)}]};
  const json = JSON.stringify(state), parts = [json.slice(0,600000),json.slice(600000)];
  const marker = `parts:2:${createHash('sha256').update(json).digest('hex')}`;
  parts.forEach((part,i) => db.prepare('INSERT INTO messages_backfill_state VALUES (?,?,?)').run('room',i,part));
  db.prepare('INSERT INTO messages_backfill_cursor VALUES (?,12,?,12,?,12,?)').run('room','event-12',marker,'');
  db.exec('BEGIN');
  migrateMessageReplaySnapshots(db);
  db.exec('COMMIT');
  assert.deepEqual(decode(db),state);
  assert.deepEqual({...db.prepare('SELECT applied_seq,state_seq,parity_at_seq,replay_event_id FROM messages_backfill_cursor').get()},
    {applied_seq:12,state_seq:12,parity_at_seq:12,replay_event_id:'event-12'});
  assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('messages_backfill_cursor') WHERE name='state_json'").get(),undefined);
  migrateMessageReplaySnapshots(db);
  assert.deepEqual(decode(db),state,'reopening migration is idempotent');
});

test('snapshot chunks preserve Unicode, reject corruption, and discard every body copy',t => {
  const db = legacyDatabase(t); migrateMessageReplaySnapshots(db);
  const state = {body:'😀漢'.repeat(450000)};
  writeMessageReplaySnapshot(db,'room',JSON.stringify(state));
  assert.deepEqual(decode(db),state);
  const parts = db.prepare('SELECT part,json FROM messages_backfill_state ORDER BY part').all();
  assert.ok(parts.length > 2);
  assert.ok(parts.every(row => Buffer.byteLength(row.json) < 2*1024*1024 && row.json.isWellFormed()));
  db.prepare('UPDATE messages_backfill_state SET json=? WHERE part=1').run('corrupt');
  assert.throws(() => decode(db),/torn/);
  discardMessageReplaySnapshot(db,'room');
  assert.equal(readMessageReplaySnapshot(db,'room'),null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages_backfill_state').get().n,0);
});

test('snapshot replacement rolls back atomically and shrinking removes obsolete private chunks',t => {
  const db = legacyDatabase(t); migrateMessageReplaySnapshots(db);
  const state = {body:'old private text'.repeat(100000)};
  writeMessageReplaySnapshot(db,'room',JSON.stringify(state));
  db.exec('BEGIN');
  writeMessageReplaySnapshot(db,'room',JSON.stringify({body:'replacement'.repeat(70000)}));
  db.exec('ROLLBACK');
  assert.deepEqual(decode(db),state);
  writeMessageReplaySnapshot(db,'room',JSON.stringify({body:null}));
  assert.deepEqual(decode(db),{body:null});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages_backfill_state').get().n,0);
});
