import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { referenceMessageEntities, hydrateMessageEntities } from '../server/message-entity-projection.mjs';
import { messageQueries, decodeMessageRecord } from '../server/message-queries.mjs';
import { messageInHistory } from '../server/history-visibility.mjs';
import { migrateMessageReplaySnapshots, readMessageReplaySnapshot, writeMessageReplaySnapshot,
  discardMessageReplaySnapshot } from '../server/message-replay-snapshot.mjs';

function messagesDb(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE messages(room_id TEXT,message_id TEXT,seq INTEGER,body TEXT,
    record_json TEXT,reducer_extras_json TEXT,author_id TEXT,to_member_id TEXT,
    channel_id TEXT,created_at TEXT,deleted_at TEXT,PRIMARY KEY(room_id,message_id));`);
  const put = (room, id, seq, overrides = {}, extras = {}) => {
    const message = { id, body: `body ${id}`, authorId: 'alice', createdAt: '2026-01-01T00:00:00Z', ...overrides };
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(room, id, seq,
      message.body, JSON.stringify(message), extras === null ? null : JSON.stringify(extras),
      message.authorId, message.toMemberId ?? null, message.channelId ?? null, message.createdAt, null);
    return message;
  };
  return { db, put };
}

test('entity references batch, preserve legacy rows, and hydrate only the requested room', t => {
  const { db, put } = messagesDb(t);
  const messages = Array.from({ length: 270 }, (_, i) => put('r', `m${i}`, i, {}, { editHistory: [] }));
  const legacy = put('r', 'legacy', 271, {}, null);
  put('other', 'm0', 0, { body: 'private' });
  const refs = referenceMessageEntities(db, 'r', [...messages, legacy, { id: 'pending' }], ['pending']);
  assert.deepEqual(refs[0], { id: 'm0', _entity: 1 });
  assert.strictEqual(refs[270], legacy);
  assert.deepEqual(refs[271], { id: 'pending', _entity: 1 });
  assert.deepEqual(hydrateMessageEntities(db, 'r', refs.slice(0, 271)),
    [...messages.map(message => ({ ...message, editHistory: [] })), legacy]);
  assert.throws(() => hydrateMessageEntities(db, 'r', refs), /missing message entity/);
  assert.throws(() => hydrateMessageEntities(db, 'r', [{ id: 'm0', _entity: 1, body: 'injected' }]), /missing message entity/);
  db.prepare("UPDATE messages SET body='corrupt' WHERE room_id='r' AND message_id='m0'").run();
  assert.throws(() => hydrateMessageEntities(db, 'r', refs.slice(0, 1)), /invalid message entity/);
});

test('archived and retained queries merge in sequence order with cursors and viewer filtering', t => {
  const { db, put } = messagesDb(t);
  put('r', 'a', 1);
  put('r', 'private', 2, { toMemberId: 'bob' });
  const retained = put('r', 'retained', 3);
  put('r', 'z', 4);
  put('other', 'leak', 1);
  const q = messageQueries({ db }, 'r', { messages: [retained] },
    { throughSeq: 4, retainedJson: JSON.stringify(['retained']) });
  const ids = options => [...q.records(options)].map(m => m.id);
  assert.deepEqual(ids(), ['a', 'private', 'retained', 'z']);
  assert.deepEqual(ids({ descending: true, afterId: 'z' }), ['retained', 'private', 'a']);
  assert.deepEqual(ids({ afterId: 'private', bodyPrefix: 'body r' }), ['retained']);
  assert.deepEqual(ids({ visibility: { viewerId: 'eve' } }), ['a', 'retained', 'z']);
  assert.deepEqual(ids({ visibility: { viewerId: 'bob' } }), ['a', 'private', 'retained', 'z']);
  assert.equal(q.countMetadata(m => !m.toMemberId), 3);
  assert.deepEqual(q.recent(2).map(m => m.id), ['retained', 'z']);
  assert.equal(q.firstPostedAtByAuthor().get('alice'), Date.parse(retained.createdAt));
  assert.throws(() => ids({ afterId: 'missing' }), /Unknown message cursor/);
  assert.throws(() => q.recent(1001), /Recent-message limit/);
  assert.throws(() => decodeMessageRecord({ message_id: 'wrong', record_json: '{"id":"a"}' }), /Invalid archived/);
});

test('viewer counts push visibility into SQL and agree with countMetadata', t => {
  const { db, put } = messagesDb(t);
  const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z';
  put('r', 'm1', 1, { createdAt: T0 });
  put('r', 'm2', 2, { createdAt: T1 });
  put('r', 'm3', 3, { createdAt: T1 });
  put('r', 'm4', 4, { createdAt: T2, toMemberId: 'bob' });
  const retained = put('r', 'm5', 5, { createdAt: T2 });
  const q = messageQueries({ db }, 'r', { messages: [retained] },
    { throughSeq: 5, retainedJson: JSON.stringify(['m5']) });
  const floor = { at: T1, sameInstant: new Set(['m2']) };
  const equivalent = (viewer, fl) => m => messageInHistory(m, fl)
    && (!m.toMemberId || m.authorId === viewer || m.toMemberId === viewer);
  for (const viewer of ['alice', 'bob', 'eve']) {
    for (const fl of [null, floor]) {
      assert.equal(q.countForViewer(viewer, fl), q.countMetadata(equivalent(viewer, fl)),
        `${viewer} floor=${Boolean(fl)}`);
    }
  }
  // Spot-check the actual numbers behind the equivalence (archived leg only):
  // floor hides m1 (before) and m2 (same instant); m4 is bob's DM.
  assert.equal(q.countArchivedForViewer('alice', floor), 2);
  assert.equal(q.countArchivedForViewer('alice', null), 4);
  assert.equal(q.countArchivedForViewer('eve', floor), 1);
  assert.equal(q.countArchivedForViewer('eve', null), 3);
  // No marker: the count is the live leg alone.
  const plain = messageQueries({ db }, 'plain', { messages: [retained, { id: 'dm', authorId: 'alice', toMemberId: 'bob', createdAt: T2 }] });
  assert.equal(plain.countForViewer('alice', null), 2);
  assert.equal(plain.countForViewer('eve', null), 1);
  assert.equal(plain.countArchivedForViewer('alice', null), 0);
});

test('the retained-set seq map is cached under (room sequence, archive marker)', t => {
  const { db, put } = messagesDb(t);
  put('c', 'a', 1);
  put('c', 'private', 2, { toMemberId: 'bob' });
  const retained = put('c', 'retained', 3);
  put('c', 'z', 4);
  let sequence = 7;
  const store = { db, room: () => ({ sequence }) };
  const marker = { throughSeq: 4, retainedJson: JSON.stringify(['retained']) };
  const ids = () => [...messageQueries(store, 'c', { messages: [retained] }, marker).records()].map(m => m.id);
  assert.deepEqual(ids(), ['a', 'private', 'retained', 'z']);
  // Move the retained row ahead of 'a' in the table: at the same room
  // sequence the cached map still pins the old order (the sequence is the
  // projection's identity, so the map cannot have changed under it)…
  db.prepare("UPDATE messages SET seq=0 WHERE room_id='c' AND message_id='retained'").run();
  assert.deepEqual(ids(), ['a', 'private', 'retained', 'z']);
  // …and the next command (sequence advances) rebuilds it.
  sequence = 8;
  assert.deepEqual(ids(), ['retained', 'a', 'private', 'z']);
});

test('replay migration preserves snapshots and event identity, is repeatable, and honors rollback', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE rooms(id TEXT PRIMARY KEY);
    INSERT INTO rooms VALUES ('r'),('other');
    CREATE TABLE events(id TEXT,room_id TEXT,sequence INTEGER);
    INSERT INTO events VALUES ('event-r','r',7);
    CREATE TABLE messages_backfill_cursor(room_id TEXT PRIMARY KEY,state_seq INTEGER,state_json TEXT);
    INSERT INTO messages_backfill_cursor VALUES ('r',7,'{"messages":[]}'),('',0,NULL);`);
  migrateMessageReplaySnapshots(db);
  migrateMessageReplaySnapshots(db);
  assert.equal(readMessageReplaySnapshot(db, 'r').state_json, '{"messages":[]}');
  assert.equal(db.prepare("SELECT replay_event_id FROM messages_backfill_cursor WHERE room_id='r'").get().replay_event_id, 'event-r');
  assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('messages_backfill_cursor') WHERE name='state_json'").get(), undefined);
  assert.equal(readMessageReplaySnapshot(db, ''), null);
  writeMessageReplaySnapshot(db, 'other', '{"other":true}');
  db.exec('BEGIN');
  writeMessageReplaySnapshot(db, 'r', '{"changed":true}');
  discardMessageReplaySnapshot(db, 'other');
  db.exec('ROLLBACK');
  assert.equal(readMessageReplaySnapshot(db, 'r').state_json, '{"messages":[]}');
  assert.equal(readMessageReplaySnapshot(db, 'other').state_json, '{"other":true}');
  discardMessageReplaySnapshot(db, 'r');
  assert.equal(readMessageReplaySnapshot(db, 'r'), null);
});
