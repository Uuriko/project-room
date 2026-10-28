import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { messageQueries } from '../server/message-queries.mjs';
import { messageInHistory } from '../server/history-visibility.mjs';

// countViewerVisible must equal countMetadata with the room read's predicate
// (messageInHistory + the DM rule) for every viewer and floor.
function fixture(db, count = 900) {
  db.exec(`CREATE TABLE messages(room_id TEXT,message_id TEXT,seq INTEGER,author_id TEXT,to_member_id TEXT,channel_id TEXT,created_at TEXT,deleted_at TEXT,record_json TEXT,body TEXT,PRIMARY KEY(room_id,message_id));
    CREATE INDEX messages_room_seq ON messages(room_id,seq);`);
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)');
  const all = [];
  for (let i = 0; i < count + 3; i++) {
    const id = `m${String(i).padStart(6, '0')}`;
    const to = i % 7 === 0 ? 'ann' : i % 11 === 0 ? 'bob' : i % 13 === 0 ? '' : null;
    const message = { id, authorId: ['ann', 'bob', 'cat'][i % 3], toMemberId: to, channelId: 'general',
      createdAt: i % 97 === 0 ? null : `2026-10-27T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      deletedAt: i % 19 === 0 ? '2026-10-27T02:00:00.000Z' : null, body: `body ${i}` };
    insert.run('room', id, Math.floor(i / 2), message.authorId, message.toMemberId, message.channelId, message.createdAt, message.deletedAt, JSON.stringify(message), message.body);
    if (i < count) all.push(message);
  }
  const retained = [all[4], all[400]];
  const marker = { throughSeq: Math.floor((count - 1) / 2), retainedJson: JSON.stringify(retained.map(m => m.id)) };
  // A live working-set message past the archive, plus the retained ones.
  const newer = JSON.parse(db.prepare("SELECT record_json FROM messages WHERE message_id=?").get(`m${String(count).padStart(6, '0')}`).record_json);
  return messageQueries({ db }, 'room', { messages: [...retained, newer] }, marker);
}

test('SQL viewer count matches the JS metadata count for every viewer and floor', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const queries = fixture(db);
    const floors = [null,
      { at: '2026-10-27T00:05:00.000Z', sameInstant: new Set() },
      { at: '2026-10-27T00:05:00.000Z', sameInstant: new Set(['m000300']) },
      { at: '2026-10-27T00:10:30.000Z', sameInstant: new Set(['m000630', 'm999999']) },
      { at: '2099-01-01T00:00:00.000Z', sameInstant: new Set() }];
    let checked = 0;
    for (const viewer of ['ann', 'bob', 'cat', 'nobody']) for (const floor of floors) {
      const visible = message => messageInHistory(message, floor)
        && (!message.toMemberId || message.authorId === viewer || message.toMemberId === viewer);
      assert.equal(queries.countViewerVisible(viewer, floor), queries.countMetadata(visible), `${viewer} ${floor?.at ?? 'no floor'}`);
      checked++;
    }
    assert.equal(checked, 20);
  } finally { db.close(); }
});

test('without an archive marker the count is the live working set only', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages(room_id TEXT,message_id TEXT,seq INTEGER)');
    const live = [{ id: 'a', authorId: 'ann', toMemberId: null, createdAt: '2026-10-27T00:00:00.000Z' },
      { id: 'b', authorId: 'bob', toMemberId: 'cat', createdAt: '2026-10-27T00:00:01.000Z' }];
    const queries = messageQueries({ db }, 'room', { messages: live }, null);
    assert.equal(queries.countViewerVisible('ann'), 1);
    assert.equal(queries.countViewerVisible('cat'), 2);
  } finally { db.close(); }
});
