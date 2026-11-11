import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readCurrentEventEnvelope, CURRENT_EVENT_ENVELOPE_BYTES, CURRENT_EVENT_RAW_MESSAGE_BYTES } from '../server/current-event-envelope.mjs';
import { redactEventPage } from '../server/redact-read.mjs';

const opening = (body, extra = {}) => ({ id: 'opening', roomId: 'room', actorId: 'owner', at: '2026-11-03T00:00:00.000Z',
  type: 'message.posted', data: { messageId: 'message', body }, ...extra });
function fixture(t, raw) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE events(room_id TEXT,sequence INTEGER,id TEXT,body TEXT,PRIMARY KEY(room_id,sequence))');
  db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('room', 1, 'opening', raw);
  t.after(() => db.close());
  const scalar = db.prepare('SELECT sequence,length(CAST(id AS BLOB)) idBytes,length(CAST(body AS BLOB)) bodyBytes FROM events').get();
  const budget = { bytes: 0, records: 0, maxRecords: 200, receipts: new Map() };
  const read = () => {
    db.exec('BEGIN');
    try { return readCurrentEventEnvelope(db, 'room', scalar, budget); }
    finally { db.exec('ROLLBACK'); }
  };
  return { db, scalar, budget, read };
}

function observeEnvelopeRows(f) {
  const returned = [];
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes('WITH source AS MATERIALIZED')) return statement;
    return { get(...args) { const row = statement.get(...args); returned.push(row); return row; } };
  };
  return returned;
}

for (const [label, body] of [['CJK', '界'.repeat(65536)], ['astral', '界' + '🪷'.repeat(32767) + '界'], ['escaped controls', '\u0001'.repeat(65536)]]) {
  for (const type of ['message.posted', 'message.edited']) test(`${type} projects a legal ${label} historical body before JS input`, t => {
    const raw = JSON.stringify(opening(body, { type })), f = fixture(t, raw);
    const returned = observeEnvelopeRows(f), value = f.read();
    assert.equal(value.rawBytes, Buffer.byteLength(raw));
    assert.ok(value.rawBytes > CURRENT_EVENT_ENVELOPE_BYTES);
    assert.equal(value.event.data.body, null);
    assert.ok(Object.hasOwn(value.event.data, 'body'));
    assert.equal(value.envelopeBytes, Buffer.byteLength(JSON.stringify(value.event)));
    assert.ok(f.budget.bytes < 1024, 'Only the bounded effective envelope enters the shared JS budget');
    assert.equal(returned.length, 1, 'One SQL query returns metadata and its admitted envelope together');
    assert.deepEqual(Object.keys(returned[0]).sort(), ['envelope', 'envelopeBytes', 'id'], 'Validation scalars stay inside SQLite instead of consuming protected input');
    assert.equal(f.budget.records, 1, 'Charge the one actual returned row');
    assert.equal(f.budget.bytes, f.scalar.idBytes + value.envelopeBytes + 32, 'Metadata and envelope bytes both remain charged');
    const page = redactEventPage({ events: [{ sequence: 1, event: value.event }] }, [{ id: 'message', body: 'Protected current text' }]);
    assert.equal(page.events[0].event.data.body, 'Protected current text');
    const erased = redactEventPage({ events: [{ sequence: 1, event: value.event }] }, []);
    assert.equal(erased.events[0].event.data.body, null);
  });
}

test('raw hard bound is derived from the UTF-16 escape bound and guards all JSON functions', t => {
  assert.equal(CURRENT_EVENT_RAW_MESSAGE_BYTES, 65536 * 6 + CURRENT_EVENT_ENVELOPE_BYTES);
  const f = fixture(t, JSON.stringify(opening('x'.repeat(CURRENT_EVENT_RAW_MESSAGE_BYTES))));
  let queried = false;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => { if (sql.includes('json_')) queried = true; return prepare(sql); };
  assert.throws(f.read, { code: 'current_room_context_unavailable' });
  assert.equal(queried, false, 'Over-bound raw bytes must not enter SQLite JSON parsing');
});

for (const [label, raw] of [
  ['invalid JSON', '{"broken":'],
  ['oversized message metadata', JSON.stringify(opening('old', { extra: 'x'.repeat(CURRENT_EVENT_ENVELOPE_BYTES) }))],
  ['oversized nonmessage', JSON.stringify(opening('x'.repeat(CURRENT_EVENT_ENVELOPE_BYTES), { type: 'decision.recorded' }))],
  ['object body', JSON.stringify(opening({ text: 'old' }))],
  ['numeric body', JSON.stringify(opening(5))],
  ['missing body', JSON.stringify({ ...opening('old'), data: { messageId: 'message' } })],
  ['duplicate body', JSON.stringify(opening('old')).replace('"body":"old"', '"body":"old","body":"second"')],
  ['duplicate data', JSON.stringify(opening('old')).replace('"data":', '"data":{"body":"second"},"data":')],
  ['duplicate type', JSON.stringify(opening('old')).replace('"type":', '"type":"message.edited","type":')]
]) test(`event envelope refuses ${label} without returning a body`, t => {
  const f = fixture(t, raw);
  const returned = observeEnvelopeRows(f);
  assert.throws(f.read, { code: 'current_room_context_unavailable' });
  assert.equal(returned.length, 1);
  assert.equal(returned[0].envelope, null, 'Invalid envelopes must be rejected in SQL before transfer');
});

test('null message bodies and ordinary nonmessage data keep existing semantics', t => {
  const erased = fixture(t, JSON.stringify(opening(null))).read();
  assert.equal(erased.event.data.body, null);
  const value = opening('Unrelated event payload', { type: 'decision.recorded' });
  assert.deepEqual(fixture(t, JSON.stringify(value)).read().event, value);
});

test('accepted redacted histories may omit body and still expose only a null tombstone', t => {
  const value = { ...opening('old'), data: { messageId: 'message', redacted: true } };
  assert.equal(fixture(t, JSON.stringify(value)).read().event.data.body, null);
});

test('effective envelopes still obey the unchanged shared input budget before transfer', t => {
  const f = fixture(t, JSON.stringify(opening('old')));
  f.budget.bytes = 256 * 1024 - 100;
  const returned = observeEnvelopeRows(f);
  assert.throws(f.read, { code: 'current_room_context_unavailable' });
  assert.equal(returned.length, 1);
  assert.ok(returned[0].envelopeBytes > 0, 'The envelope exists inside SQLite');
  assert.equal(returned[0].envelope, null, 'The query-bound remaining allowance prevents its transfer');
  assert.equal(f.budget.records, 1);
});

for (const excess of [0, 1]) test(`shared byte boundary ${excess ? 'refuses one excess byte' : 'admits exactly the remaining bytes'}`, t => {
  const f = fixture(t, JSON.stringify(opening('old')));
  const required = f.scalar.idBytes + Buffer.byteLength(JSON.stringify(opening(null))) + 32;
  f.budget.bytes = 256 * 1024 - required + excess;
  const returned = observeEnvelopeRows(f);
  if (excess) {
    assert.throws(f.read, { code: 'current_room_context_unavailable' });
    assert.equal(returned[0].envelope, null);
  } else {
    assert.equal(f.read().event.data.body, null);
    assert.equal(f.budget.bytes, 256 * 1024);
    assert.equal(typeof returned[0].envelope, 'string');
  }
  assert.equal(returned.length, 1);
  assert.equal(f.budget.records, 1);
});

for (const exhausted of ['metadata bytes', 'records']) test(`exhausted ${exhausted} refuses before the SQL row is transferred`, t => {
  const f = fixture(t, JSON.stringify(opening('old')));
  if (exhausted === 'metadata bytes') f.budget.bytes = 256 * 1024 - 1;
  else f.budget.records = 200;
  const returned = observeEnvelopeRows(f);
  assert.throws(f.read, { code: 'current_room_context_unavailable' });
  assert.equal(returned.length, 0);
});

test('source scalar size drift refuses inside SQLite without transferring the envelope', t => {
  const f = fixture(t, JSON.stringify(opening('old')));
  f.scalar.bodyBytes--;
  const returned = observeEnvelopeRows(f);
  assert.throws(f.read, { code: 'current_room_context_unavailable' });
  assert.equal(returned.length, 1);
  assert.equal(returned[0].envelope, null);
});
