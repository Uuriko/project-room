// Bounded DM scan (stacked on RES-1538 round 3): roomDmsOf used to
// batch-loop a json_extract-filtered query until the kind filled or
// the range ended — the LIMIT-after-filter shape refuted for the reply
// scan in round 2. Measured against harness fixtures with the module's
// exact pre-cure SQL (progress-handler VM counts): 9,096 instructions
// at 1,008 plain events growing to 90,096 at 10,008, ~9 per event,
// with zero DM rows returned. The cure steps the range through the
// same scalar prefix admission as the reply and mention scans
// (DM_SCAN_ROW_BUDGET / DM_SCAN_BYTE_BUDGET, scan report component
// scan.dms): examined rows and bytes are budget-bound, a budget stop
// reports exhausted with scannedThrough, sparse DMs are delivered by
// continuation exactly once, an event larger than the whole byte
// budget refuses typed 503 before its payload is fetched, and a
// deleted DM costs budget but never one of the kind's slots. These
// tests pin the contract at the scan level with a synthetic
// node:sqlite store in the admission suite's shapes and accounting;
// the module is loaded through the same export-only adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { DM_SCAN_ROW_BUDGET, DM_SCAN_BYTE_BUDGET } from '../server/needs-me.mjs';

const adapterPath = new URL('../server/.needs-me-dms-under-test.mjs', import.meta.url);
writeFileSync(adapterPath, readFileSync(new URL('../server/needs-me.mjs', import.meta.url), 'utf8')
  + '\nexport { roomDmsOf };\n');
const { roomDmsOf } = await import(adapterPath);
rmSync(adapterPath, { force: true });

function syntheticStore(events, { state } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE rooms(id TEXT PRIMARY KEY);
    INSERT INTO rooms VALUES('room');
    CREATE TABLE events(room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));`);
  const insert = raw.prepare('INSERT INTO events VALUES(?,?,?,?)');
  for (const event of events) insert.run('room', event.sequence, event.id, event.body);
  const meter = { payloadRows: 0, payloadBytes: 0 };
  const count = rows => {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.body === 'string') meter.payloadRows += 1;
      for (const key of ['body', 'id', 'eventId']) {
        if (typeof row[key] === 'string') meter.payloadBytes += Buffer.byteLength(row[key]);
      }
    }
    return rows;
  };
  const db = {
    prepare(text) {
      const stmt = raw.prepare(text);
      return {
        all: (...args) => count(stmt.all(...args)),
        get: (...args) => count([stmt.get(...args)])[0],
        run: (...args) => stmt.run(...args)
      };
    },
    exec: text => raw.exec(text)
  };
  const roomState = state ?? { room: { id: 'room' }, messages: [], replyRequests: {} };
  const store = { db, now: () => 0, state: roomState, room: () => ({ state: roomState }), readTransaction(fn) { return fn(); } };
  return { store, meter };
}

const posted = (sequence, data, actorId = 'writer') => ({
  sequence,
  id: `event-${sequence}`,
  body: JSON.stringify({ id: `event-${sequence}`, type: 'message.posted', actorId, data })
});
const dm = (sequence, body = 'a dm') => posted(sequence, { messageId: `event-${sequence}`, body, toMemberId: 'viewer' });
const plain = sequence => posted(sequence, { messageId: `event-${sequence}`, body: 'plain post' });

test('dm scan: a no-match history costs the budget, not the history size', () => {
  for (const count of [320, 3200]) {
    const events = Array.from({ length: count }, (_, i) => plain(i + 1));
    const { store } = syntheticStore(events);
    const scan = roomDmsOf(store, 'room', 'viewer', 0, count, store.state);
    assert.equal(scan.scannedRows, DM_SCAN_ROW_BUDGET, `at ${count} events the scan examines its budget`);
    assert.equal(scan.exhausted, true);
    assert.deepEqual(scan.items, []);
  }
});

test('dm scan: sparse DMs are delivered by continuation exactly once', () => {
  const events = [];
  for (let seq = 1; seq <= 900; seq++) events.push(seq % 300 === 0 ? dm(seq, `dm at ${seq}`) : plain(seq));
  const { store } = syntheticStore(events);
  const delivered = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const scan = roomDmsOf(store, 'room', 'viewer', after, 900, store.state);
    assert.ok(scan.scannedRows <= DM_SCAN_ROW_BUDGET, 'each read stays inside the budget');
    delivered.push(...scan.items.map(item => item.id));
    if (!scan.exhausted) break;
    after = scan.scannedThrough;
  }
  assert.deepEqual(delivered.sort(), ['event-300', 'event-600', 'event-900']);
  assert.equal(new Set(delivered).size, delivered.length, 'no DM is delivered twice');
});

test('dm scan: byte admission stops before the crossing row', () => {
  const events = Array.from({ length: 20 }, (_, i) => dm(i + 1, 'x'.repeat(60_000)));
  const { store, meter } = syntheticStore(events);
  const scan = roomDmsOf(store, 'room', 'viewer', 0, 20, store.state);
  assert.ok(scan.scannedBytes <= DM_SCAN_BYTE_BUDGET, `examined bytes stay inside the budget (got ${scan.scannedBytes})`);
  assert.ok(scan.scannedBytes + 60_011 > DM_SCAN_BYTE_BUDGET, 'every row that fits was admitted');
  assert.equal(scan.exhausted, true);
  assert.equal(meter.payloadRows, scan.scannedRows, 'fetched rows are the examined rows');
});

test('dm scan: an event larger than the whole byte budget refuses typed 503 before payload fetch', () => {
  const events = [posted(1, { messageId: 'event-1', body: 'x'.repeat(DM_SCAN_BYTE_BUDGET + 1), toMemberId: 'viewer' })];
  const { store, meter } = syntheticStore(events);
  assert.throws(
    () => roomDmsOf(store, 'room', 'viewer', 0, 1, store.state),
    error => error?.status === 503 && error?.code === 'storage_unavailable'
  );
  assert.equal(meter.payloadBytes, 0);
});

test('dm scan: a deleted DM costs budget, never a slot', () => {
  const events = [dm(1, 'deleted dm')];
  for (let seq = 2; seq <= 11; seq++) events.push(dm(seq, `live dm ${seq}`));
  const state = { room: { id: 'room' }, messages: [{ id: 'event-1', authorId: 'writer', body: 'deleted dm', deletedAt: 1 }], replyRequests: {} };
  const { store } = syntheticStore(events, { state });
  const scan = roomDmsOf(store, 'room', 'viewer', 0, 11, state);
  assert.equal(scan.items.length, 9, 'the kind still fills to MAX_PER_KIND + 1 from the live DMs behind the deleted one');
  assert.ok(!scan.items.some(item => item.id === 'event-1'), 'the deleted DM never surfaces');
});
