import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

// Independent original predicate: the shared viewer-less response must never
// expose a private post or any of its follow-ups as public activity.
const original = `SELECT json_extract(e.body,'$.actorId') AS actor, max(json_extract(e.body,'$.at')) AS at
FROM events e WHERE e.room_id=? AND NOT (
 (json_extract(e.body,'$.type')='message.posted' AND COALESCE(json_extract(e.body,'$.data.toMemberId'),'')<>'')
 OR (json_extract(e.body,'$.type') IN ('message.edited','message.deleted','message.redacted','poll.voted','message.pinned','message.unpinned')
 AND EXISTS (SELECT 1 FROM events p WHERE p.room_id=e.room_id AND json_extract(p.body,'$.type')='message.posted'
 AND COALESCE(json_extract(p.body,'$.data.toMemberId'),'')<>''
 AND (json_extract(p.body,'$.data.messageId')=json_extract(e.body,'$.data.messageId') OR p.id=json_extract(e.body,'$.data.messageId')))))
GROUP BY actor`;
function actualQuery() {
  const store = new RoomStore(':memory:');
  try {
    store.initialize(initialRoom());
    const key = store.issueAccessKey('commons', 'owner');
    const prepare = store.db.prepare.bind(store.db);
    let query;
    store.db.prepare = sql => {
      if (sql.includes('GROUP BY actor') && sql.includes('FROM events e')) query = sql;
      return prepare(sql);
    };
    assert.equal(store.presence(key, 'commons', []).members.length, 1);
    assert.ok(query);
    return query;
  } finally { store.close(); }
}

test('presence query preserves private follow-up, SQL null/type, actor and room semantics', () => {
  const query = actualQuery(), db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE events(room_id TEXT,sequence INTEGER,id TEXT,body TEXT); CREATE INDEX events_room ON events(room_id,sequence)');
    const put = db.prepare('INSERT INTO events VALUES(?,?,?,?)');
    const values = [null, '', 0, 1, '0', '1', true, false, 1.5, '1.5', [], {}, ['x'], 'p', 'other'];
    const types = ['message.edited', 'message.deleted', 'message.redacted', 'poll.voted', 'message.pinned', 'message.unpinned', 'unrelated'];
    let cases = 0;
    for (const target of values) for (const id of values.filter(v => typeof v === 'string')) {
      db.exec('DELETE FROM events');
      let sequence = 0;
      const insert = (room, eventId, type, data, actor) => {
        put.run(room, ++sequence, eventId, JSON.stringify({type, data, actorId:actor, at:String(sequence).padStart(6, '0')}));
      };
      insert('r', 'public', 'room.updated', {}, 'public-actor');
      insert('r', id, 'message.posted', {messageId:target, toMemberId:'private-recipient'}, 'private-author');
      for (const value of values) for (const type of types) {
        insert('r', 'follow-' + sequence, type, {messageId:value}, 'actor-' + sequence);
      }
      // A private message in another room must not suppress this room's activity.
      insert('elsewhere', 'foreign', 'message.posted', {messageId:'other', toMemberId:'private'}, 'foreign');
      assert.deepEqual(db.prepare(query).all('r', 'r'), db.prepare(original).all('r'), JSON.stringify({id,target}));
      cases++;
    }
    assert.equal(cases, 90);
    // Causal performance contract: SQLite constructs two reusable membership
    // sets; it must not evaluate a correlated history scan per outer event.
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + query).all('r', 'r').map(row => row.detail).join('\n');
    assert.match(plan, /MATERIALIZE private_posts/);
    assert.doesNotMatch(plan, /CORRELATED/);
    assert.match(db.prepare('EXPLAIN QUERY PLAN ' + original).all('r').map(row => row.detail).join('\n'), /CORRELATED/);
  } finally { db.close(); }
});
