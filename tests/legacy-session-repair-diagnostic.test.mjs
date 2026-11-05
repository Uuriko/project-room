import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { repairLegacyMessages } from '../server/operator-legacy-message-repair.mjs';
import { projectionDigest, projectionContentHash } from '../server/write-integrity.mjs';
import { seedLegacyFixture } from './helpers/legacy-session-fixture.mjs';

const roomId = 'legacy-room';
function fixture(t) {
  const s = new RoomStore(':memory:');
  t.after(() => s.close());
  return seedLegacyFixture(s);
}
function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
// Test-only independently staged damaged fixtures. Recompute earlier witnesses
// explicitly to reach a later guard, never through the production repair.
function witness(f) {
  const row = f.s.db.prepare('SELECT sequence,projection FROM rooms WHERE id=?').get(roomId);
  f.s.db.prepare('UPDATE integrity_room_state SET metadata_hash=?,projection_hash=? WHERE room_id=?')
    .run(projectionDigest(row.projection), projectionContentHash(f.s.db, roomId, row.sequence, row.projection), roomId);
}
function projection(f, change) {
  const row = f.s.db.prepare('SELECT projection FROM rooms WHERE id=?').get(roomId);
  const state = JSON.parse(row.projection); change(state);
  f.s.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), roomId);
  witness(f);
}
const cases = [
  ['metadata_proof_missing', f => f.s.db.prepare('UPDATE integrity_room_state SET metadata_hash=NULL WHERE room_id=?').run(roomId)],
  ['content_proof_missing', f => f.s.db.prepare('UPDATE integrity_room_state SET projection_hash=NULL WHERE room_id=?').run(roomId)],
  ['proof_head_mismatch', f => f.s.db.prepare('UPDATE integrity_room_state SET sequence=sequence-1 WHERE room_id=?').run(roomId)],
  ['metadata_hash_mismatch', f => f.s.db.prepare("UPDATE integrity_room_state SET metadata_hash='wrong' WHERE room_id=?").run(roomId)],
  ['content_hash_mismatch', f => f.s.db.prepare("UPDATE integrity_room_state SET projection_hash='wrong' WHERE room_id=?").run(roomId)],
  ['serving_proof_drift', f => { f.s.db.prepare("UPDATE work_entities SET digest='wrong' WHERE room_id=?").run(roomId); witness(f); }],
  ['message_proof_missing', f => f.s.db.prepare('UPDATE messages SET entity_hash=NULL WHERE room_id=?').run(roomId)],
  ['message_proof_mismatch', f => f.s.db.prepare("UPDATE messages SET entity_hash='wrong' WHERE room_id=?").run(roomId)],
  ['projection_body_proof_mismatch', f => f.s.db.prepare('INSERT INTO projection_bodies(room_id,sha,body) VALUES(?,?,?)').run(roomId, '0'.repeat(64), 'synthetic private sentinel')],
  ['message_reference_invalid', f => projection(f, state => { state.messages[0] = { id: 'missing-synthetic', _entity: 1 }; })],
  ['work_membership_mismatch', f => { const row = f.s.db.prepare('SELECT * FROM work_entities WHERE room_id=?').get(roomId); f.s.db.prepare('INSERT INTO work_entities(room_id,work_id,revision,digest,body) VALUES(?,?,?,?,?)').run(roomId, 'unreferenced', row.revision, row.digest, row.body); witness(f); }],
  ['work_reference_proof_mismatch', f => projection(f, state => { state.workItems.task.id = 'wrong-synthetic'; })],
  ['work_body_identity_mismatch', f => {
    const row = f.s.db.prepare('SELECT body FROM work_entities WHERE room_id=?').get(roomId);
    const value = JSON.parse(row.body); value.id = 'wrong-synthetic'; const body = JSON.stringify(value), digest = projectionDigest(body);
    f.s.db.prepare('UPDATE work_entities SET body=?,digest=? WHERE room_id=?').run(body, digest, roomId);
    projection(f, state => { state.workItems.task.digest = digest; });
  }],
  ['hydration_body_missing', f => projection(f, state => { state.messages[0].bodyRef = 'missing-synthetic'; delete state.messages[0].body; })]
];
for (const [repairCheck, damage] of cases) test(`fixed diagnostic ${repairCheck} refuses without any database change`, t => {
  const f = fixture(t); damage(f); const before = snapshot(f.s.db);
  assert.throws(() => repairLegacyMessages(f.s, f.request), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'repair_projection_unavailable');
    assert.equal(error.message, 'Historical session repair refused; inspect fresh plan and independent serving proofs');
    assert.deepEqual(error.detail, { repairCheck }); return true;
  });
  assert.deepEqual(snapshot(f.s.db), before);
});
for (let index = 0; index < cases.length - 1; index++) test(`refusal precedence ${cases[index][0]} before ${cases[index + 1][0]}`, t => {
  const f = fixture(t);
  // Apply the later fault first: an earlier fault remains the first predicate
  // even when another independent guard would also reject the same fixture.
  cases[index + 1][1](f); cases[index][1](f);
  const before = snapshot(f.s.db);
  assert.throws(() => repairLegacyMessages(f.s, f.request), error => error.detail?.repairCheck === cases[index][0]);
  assert.deepEqual(snapshot(f.s.db), before);
});
test('first refusal retains short circuit and never reaches serving payload scans', t => {
  const f = fixture(t); f.s.db.prepare('UPDATE integrity_room_state SET metadata_hash=NULL,projection_hash=NULL WHERE room_id=?').run(roomId);
  const prepare = f.s.db.prepare.bind(f.s.db); let scans = 0;
  f.s.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('ORDER BY work_id') || sql.includes('ORDER BY message_id')) {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = (...args) => { scans++; return iterate(...args); };
    }
    return statement;
  };
  assert.throws(() => repairLegacyMessages(f.s, f.request), error => error.detail?.repairCheck === 'metadata_proof_missing');
  assert.equal(scans, 0);
});
test('storage exceptions preserve identity and are not relabeled as repair diagnostics', t => {
  const f = fixture(t), before = snapshot(f.s.db), prepare = f.s.db.prepare.bind(f.s.db), fault = Object.assign(new Error('synthetic I/O fault'), { code: 'SQLITE_IOERR' });
  f.s.db.prepare = sql => { if (sql.startsWith('SELECT metadata_hash FROM integrity_room_state')) throw fault; return prepare(sql); };
  assert.throws(() => repairLegacyMessages(f.s, f.request), error => error === fault && error.detail === undefined);
  f.s.db.prepare = prepare; assert.deepEqual(snapshot(f.s.db), before);
});
test('operator HTTP exposes only fixed enum after token authorization', async t => {
  const f = fixture(t), token = 'synthetic-repair-diagnostic-operator', previous = process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = createHash('sha256').update(token).digest('hex');
  const server = createRoomServer({ store: f.s }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.ROOM_OPERATOR_TOKEN_SHA256; else process.env.ROOM_OPERATOR_TOKEN_SHA256 = previous; });
  f.s.db.prepare('UPDATE integrity_room_state SET metadata_hash=NULL WHERE room_id=?').run(roomId);
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const authorization of [null, 'Operator wrong', 'Operator ' + token]) {
    const response = await fetch(origin + '/api/operator/messages/legacy-repair/plan', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(f.request) });
    const body = await response.json();
    if (authorization !== 'Operator ' + token) { assert.equal(response.status, 404); assert.equal(body.repairCheck, undefined); }
    else { assert.equal(response.status, 409); assert.equal(body.error.code, 'repair_projection_unavailable'); assert.equal(body.repairCheck, 'metadata_proof_missing'); assert.match(body.operationId, /^op_/); }
    assert.ok(!JSON.stringify(body).includes('synthetic private sentinel')); assert.ok(!JSON.stringify(body).includes(roomId));
  }
});
