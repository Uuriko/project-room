import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MESSAGE_PROOF_FIELDS} from '../server/write-integrity.mjs';
import {auditMessageInputPage, messageInputPageSql} from '../scripts/audit-current-message-input.mjs';
test('scalar census pages without returning content or treating a full page as complete', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE messages(room_id TEXT,message_id TEXT,${MESSAGE_PROOF_FIELDS.filter(k => k !== 'message_id').map(k => k + ' TEXT').join(',')},PRIMARY KEY(room_id,message_id)); CREATE TABLE current_room_head(room_id TEXT PRIMARY KEY); INSERT INTO current_room_head VALUES('current')`);
    const insert = db.prepare('INSERT INTO messages(room_id,message_id,body) VALUES(?,?,?)');
    for (let i = 0; i < 22; i++) insert.run('current', String(i).padStart(2, '0'), i === 0 ? 'private'.repeat(140000) : i === 1 ? 'x'.repeat(150000) : 'secret');
    insert.run('legacy', 'x', 'retained');
    const before = db.prepare('SELECT total_changes() n').get().n;
    const one = auditMessageInputPage(db); assert.equal(one.examined, 20); assert.equal(one.complete, false);
    assert.equal(one.classes.aboveDerivedCeiling, 1); assert.equal(one.classes.aboveFormer128KiB, 1);
    const two = auditMessageInputPage(db, {after: one.next}); assert.equal(two.examined, 3); assert.equal(two.complete, true); assert.equal(two.classes.legacy, 1);
    assert.equal(JSON.stringify(one).includes('private'), false); assert.equal(JSON.stringify(two).includes('retained'), false);
    const selected = auditMessageInputPage(db, {roomId: 'legacy'}); assert.equal(selected.examined, 1);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
    assert.throws(() => auditMessageInputPage(db, {limit: 21}));
    assert.throws(() => auditMessageInputPage(db, {roomId: 'current', after: ['legacy', 'x']}));
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + messageInputPageSql({selectedRoom: true})).all('current', '', 20);
    assert.ok(plan.some(r => /SEARCH m USING INDEX/.test(r.detail)));
  } finally { db.close(); }
});
