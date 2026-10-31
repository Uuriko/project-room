import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { operatorParityDiagnostics } from '../server/operator-parity-diagnostics.mjs';
import { operatorStatus } from '../server/operator-status.mjs';

function fixture(t, { bodiesAtRest = false } = {}) {
  const store = new RoomStore(':memory:', { bodiesAtRest }); t.after(() => store.close());
  store.initialize([...initialRoom('commons'),
    event({ type: 'message.posted', actorId: 'owner', roomId: 'commons', id: 'post', at: new Date().toISOString(), data: {
      messageId: 'card', body: 'PRIVATE_WORDING '.repeat(100), kind: 'receipt_card', claimId: 'claim', receiptId: 'custom-receipt',
      title: 'Done', closedBy: 'Owner', deliveryMode: 'merged', evidence: 'PRIVATE_EVIDENCE'
    } })]);
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  store.checkMessagesParity({ roomId: 'commons' });
  store.recordIntegrityFailure('messages_parity', 'commons', new Error('messages parity failed for commons: current record card differs'));
  return store;
}
function diagnose(store, options) {
  const snapshot = () => JSON.stringify({ changes: store.db.prepare('SELECT total_changes() AS n').get().n,
    cursors: store.db.prepare('SELECT * FROM messages_backfill_cursor').all(), failures: store.db.prepare('SELECT * FROM integrity_failures').all(),
    projection: store.db.prepare('SELECT projection FROM rooms').all(), messages: store.db.prepare('SELECT * FROM messages').all() });
  const before = snapshot();
  const value = operatorParityDiagnostics(store, options);
  assert.ok(snapshot() === before, 'diagnosis must not modify SQL, certification, projection, or failure records');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|custom-receipt|claim|evil-key/);
  return value.rooms[0];
}
function editProjection(store, edit) {
  const state = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  edit(state.messages[0]);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
}
for (const bodiesAtRest of [false, true]) test(`stale historical failure can diagnose current clean state without writes (bodiesAtRest=${bodiesAtRest})`, t => {
  const result = diagnose(fixture(t, { bodiesAtRest }));
  assert.equal(result.status, 'clean'); assert.equal(result.complete, true); assert.equal(result.exactLegacyShapeOnly, false);
});
for (const mode of ['absent_receipt', 'null_receipt', 'reactions']) test(`exact legacy ${mode} classification uses actual normalized records`, t => {
  const store = fixture(t);
  editProjection(store, message => {
    if (mode === 'absent_receipt') delete message.receiptId;
    if (mode === 'null_receipt') message.receiptId = null;
    if (mode === 'reactions') message.reactions = { PRIVATE_WORDING: ['owner'] };
  });
  const result = diagnose(store);
  assert.deepEqual(result.fields, ['record_json']); assert.equal(result.exactLegacyShapeOnly, true);
  assert.deepEqual(result.recordJsonKeys, [mode === 'reactions' ? 'reactions' : 'receiptId']);
});
for (const [field, sql] of [
  ['body', "UPDATE messages SET body='PRIVATE_CORRUPTION'"],
  ['seq', 'UPDATE messages SET seq=1'],
  ['missing_row', 'DELETE FROM messages'],
  ['record_json', `UPDATE messages SET record_json=json_set(record_json,'$.evil-key-PRIVATE','PRIVATE_CORRUPTION')`]
]) test(`${field} drift never claims legacy-only repair`, t => {
  const store = fixture(t); store.db.exec(sql);
  const result = diagnose(store);
  assert.equal(result.status, 'mismatch'); assert.ok(result.fields.includes(field)); assert.equal(result.exactLegacyShapeOnly, false);
});
test('extra row is distinct from a legacy field mismatch', t => {
  const store = fixture(t); const row = store.db.prepare('SELECT * FROM messages').get(); row.message_id = 'extra';
  store.db.prepare(`INSERT INTO messages(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  const result = diagnose(store); assert.equal(result.extraRows, 1); assert.ok(result.fields.includes('extra_row')); assert.equal(result.exactLegacyShapeOnly, false);
});
test('bounded or incomplete diagnosis returns unknown, never clean or legacy-only', t => {
  const store = fixture(t);
  assert.equal(diagnose(store, { budgetMs: 0 }).reason, 'budget_exceeded');
  store.db.exec("UPDATE messages_backfill_cursor SET applied_seq=0 WHERE room_id='commons'");
  const result = diagnose(store); assert.equal(result.reason, 'not_caught_up'); assert.equal(result.complete, false); assert.equal(result.exactLegacyShapeOnly, false);
});
test('large source and missing external bodies fail closed without recovery writes', t => {
  const store = fixture(t, { bodiesAtRest: true });
  store.db.exec('DELETE FROM projection_bodies');
  const result = diagnose(store); assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'body_missing');
  store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.padding',?) WHERE id='commons'").run('x'.repeat(4 * 1024 * 1024));
  assert.equal(diagnose(store).reason, 'byte_limit');
});

test('archived rows still require canonical aggregate posting sequence', t => {
  const store = fixture(t);
  const state = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  const seq = store.db.prepare('SELECT seq FROM messages').get().seq;
  state.messages = []; state.messagesArchive = { throughSeq: seq, count: 1, retainedIds: [] };
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(state));
  assert.equal(diagnose(store).status, 'clean');
  store.db.prepare('UPDATE messages SET seq=?').run(seq - 1);
  assert.deepEqual(diagnose(store).fields, ['last_sequence']);
});
test('row and event limits explicitly refuse partial certification', t => {
  const store = fixture(t); const row = store.db.prepare('SELECT * FROM messages').get();
  const insert = store.db.prepare(`INSERT INTO messages(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`);
  for (let n = 0; n < 500; n++) insert.run(...Object.values({ ...row, message_id: `extra-${n}` }));
  assert.equal(diagnose(store).reason, 'row_limit');
  store.db.exec("DELETE FROM messages WHERE message_id != 'card'");
  const eventRow = store.db.prepare('SELECT * FROM events LIMIT 1').get();
  const eventInsert = store.db.prepare(`INSERT INTO events(${Object.keys(eventRow).join(',')}) VALUES(${Object.keys(eventRow).map(() => '?').join(',')})`);
  for (let n = 0; n < 2001; n++) eventInsert.run(...Object.values({ ...eventRow, sequence: 10000 + n, id: `bounded-${n}` }));
  assert.equal(diagnose(store).reason, 'event_limit');
});
test('budget exhaustion midway through comparison stays unknown', t => {
  const store = fixture(t); let tick = 0;
  const result = diagnose(store, { now: () => tick++ * 40 });
  assert.equal(result.reason, 'budget_exceeded'); assert.equal(result.complete, false);
});

test('operator status exposes bounded metadata and truncated rooms remain explicit', t => {
  const store = fixture(t);
  const changes = () => store.db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  const status = operatorStatus(store);
  assert.equal(status.messageParityDiagnostics.rooms[0].status, 'clean');
  assert.equal(changes(), before);
  for (let n = 0; n < 6; n++) store.recordIntegrityFailure('messages_parity', `missing-${n}`, new Error('unclassified'));
  const boundedBefore = changes();
  const result = operatorParityDiagnostics(store);
  assert.equal(result.truncated, true); assert.equal(result.rooms.length, 5);
  assert.ok(result.rooms.slice(1).every(room => room.status === 'unknown' && room.reason === 'room_missing'));
  assert.equal(changes(), boundedBefore);
});

for (const mode of ['wrong_anchor', 'empty_anchor', 'missing_head_event']) test(`${mode} is not a caught-up comparison`, t => {
  const store = fixture(t);
  if (mode === 'missing_head_event') {
    store.db.exec("DELETE FROM events WHERE room_id='commons' AND sequence=(SELECT sequence FROM rooms WHERE id='commons')");
  } else {
    store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id=? WHERE room_id='commons'").run(mode === 'empty_anchor' ? '' : 'wrong');
  }
  const result = diagnose(store);
  assert.equal(result.reason, 'not_caught_up'); assert.equal(result.complete, false);
  assert.equal(result.status, 'unknown'); assert.equal(result.exactLegacyShapeOnly, false);
});
for (const marker of [null, {throughSeq: '100', count: 1, retainedIds: ['card']}, {throughSeq: -1, count: 1}, {throughSeq: 1, count: '1', retainedIds: [null, 123, 'card']}]) test(`archive descriptor uses canonical normalization: ${JSON.stringify(marker)}`, t => {
  const store = fixture(t);
  store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.messagesArchive',json(?)) WHERE id='commons'").run(JSON.stringify(marker));
  assert.equal(store.checkMessagesParity({roomId: 'commons'}).ok, true);
  assert.equal(diagnose(store).status, 'clean');
});
