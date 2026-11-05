import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pre749PrefixDigest, decodeHistoricalEventRows } from '../server/historical-replay-contract.mjs';
import { RoomStore } from '../server/store.mjs';
import { repairLegacyMessages } from '../server/operator-legacy-message-repair.mjs';
import { historicalSequence, seedLegacyFixture } from './helpers/legacy-session-fixture.mjs';

for (const column of ['id', 'body']) test(`raw ${column} distinguishes valid replacement character from invalid SQLite TEXT`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE events(sequence INTEGER,id TEXT,body TEXT)');
    db.prepare('INSERT INTO events VALUES(1,?,?)').run('source', 'source');
    db.prepare(`UPDATE events SET ${column}=CAST(? AS TEXT)`).run(Buffer.from('efbfbd', 'hex'));
    const validText = db.prepare('SELECT sequence,id,body FROM events').get();
    const validRaw = db.prepare('SELECT sequence,CAST(id AS BLOB) AS id,CAST(body AS BLOB) AS body FROM events').get();
    db.prepare(`UPDATE events SET ${column}=CAST(? AS TEXT)`).run(Buffer.from('80', 'hex'));
    const invalidText = db.prepare('SELECT sequence,id,body FROM events').get();
    const invalidRaw = db.prepare('SELECT sequence,CAST(id AS BLOB) AS id,CAST(body AS BLOB) AS body FROM events').get();
    assert.deepEqual(invalidText, validText, 'driver-decoded TEXT aliases distinct SQL bytes');
    assert.notDeepEqual(invalidRaw, validRaw);
    assert.match(pre749PrefixDigest('room', [validRaw]), /^[a-f0-9]{64}$/);
    assert.throws(() => pre749PrefixDigest('room', [invalidRaw]), TypeError);
    assert.throws(() => pre749PrefixDigest('room', [validText]), TypeError, 'decoded TEXT is not byte provenance');
  } finally { db.close(); }
});

for (const column of ['body']) test(`repair refuses invalid UTF-8 ${column} before replay or proof adoption`, t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const events = historicalSequence();
  const source = events.find(e => e.type === 'work.accepted');
  if (column === 'id') source.id += '\ufffd';
  else source.data.note = '\ufffd';
  const f = seedLegacyFixture(s, events);
  s.db.prepare('UPDATE messages SET entity_hash=NULL WHERE room_id=?').run('legacy-room');
  const request = { ...f.request, messageProofMode: 'adopt-absent-inline-v1' };
  assert.equal(repairLegacyMessages(s, request).messageProofsToAdopt, 1, 'valid replacement character is lawful source');
  const row = s.db.prepare(`SELECT sequence,CAST(${column} AS BLOB) AS bytes FROM events WHERE id=?`).get(source.id);
  const original = Buffer.from(row.bytes), marker = Buffer.from('\ufffd'), offset = original.indexOf(marker);
  assert.ok(offset >= 0);
  const damaged = Buffer.concat([original.subarray(0, offset), Buffer.from([0x80]), original.subarray(offset + marker.length)]);
  s.db.prepare(`UPDATE events SET ${column}=CAST(? AS TEXT) WHERE sequence=? AND room_id=?`).run(damaged, row.sequence, 'legacy-room');
  const auditBefore = s.db.prepare('SELECT count(*) AS n FROM operator_actions').get().n;
  assert.throws(() => repairLegacyMessages(s, request), e => e.code === 'repair_not_exact_legacy' && e.status === 409);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM operator_actions').get().n, auditBefore);
  assert.equal(s.db.prepare('SELECT entity_hash FROM messages').get().entity_hash, null);
  assert.deepEqual(Buffer.from(s.db.prepare(`SELECT CAST(${column} AS BLOB) AS bytes FROM events WHERE sequence=?`).get(row.sequence).bytes), damaged);
});

test('raw contract preserves valid UTF-8 framing and BOM across SQLite buffer representations', () => {
  const row = { sequence: 1, id: 'event', body: '\ufeffnote \ufffd café' };
  const hash = createHash('sha256');
  for (const value of ['project-room.historical-replay-prefix.v1', 'room', '1', row.id, row.body])
    hash.update(String(Buffer.byteLength(value))).update(':').update(value);
  const raw = { ...row, id: Uint8Array.from(Buffer.from(row.id)).buffer, body: Uint8Array.from(Buffer.from(row.body)).buffer };
  assert.equal(pre749PrefixDigest('room', [raw]), hash.digest('hex'));
  assert.deepEqual(decodeHistoricalEventRows([raw]), [row]);
  for (const bytes of [[0xc0,0x80], [0xe2,0x82], [0xed,0xa0,0x80], [0xf4,0x90,0x80,0x80]])
    assert.throws(() => pre749PrefixDigest('room', [{ ...raw, body: Uint8Array.from(bytes) }]), TypeError);
});
