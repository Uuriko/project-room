// Round 3 of W2-F9-CURE (RES-1538, Codex's Worker admission falsifier,
// room seq 25331): the round-2 stepper fetched a batch's bodies first
// and counted them afterwards, so the byte budget bound AFTER the
// payload had already crossed from SQL into JS, and covered replies
// refetched overlapping batches after the candidate break. Measured in
// the independent Worker probe at the round-2 head (branch
// codex/review-needs-me-cure2-1101, preserved there):
//   - 3 legal escaped events transferred 1,179,969B and succeeded with
//     no honest exhaustion (each event's data.body is 65,536 U+0001
//     chars, which JSON-escapes to ~393KB stored);
//   - one imported event with a 1,048,577-char body transferred
//     1,048,684B and succeeded under the at-least-one-row rule;
//   - 1,000 covered replies fetched 1,625 payload rows (2,137 rowsRead)
//     while the scan reported 256 examined.
// The cure admits before it fetches: a scalar prefix pass reads only
// (sequence, stored octet length), admits the longest prefix fitting
// the remaining budgets, fetches exactly those bodies, and charges
// exactly the fetched rows. These tests pin that contract against a
// synthetic store over node:sqlite with the probe's own shapes and its
// payload accounting (bytes/rows whose body crossed into JS). At the
// round-2 head the first three tests fail with the probe's numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { REPLY_SCAN_BYTE_BUDGET } from '../server/needs-me.mjs';

// The two scans are module-internal (collectNeedsMe and the digest
// slice compose them). Like Codex's Worker probe, this file loads the
// module through an export-only adapter — the real source plus one
// appended export line, written beside the original so its relative
// imports resolve — so the committed module surface stays unchanged
// and the probe on Codex's branch keeps running against future heads.
const adapterPath = new URL('../server/.needs-me-admission-under-test.mjs', import.meta.url);
writeFileSync(adapterPath, readFileSync(new URL('../server/needs-me.mjs', import.meta.url), 'utf8')
  + '\nexport { repliesOf, mentionHorizon };\n');
const { repliesOf, mentionHorizon } = await import(adapterPath);
rmSync(adapterPath, { force: true });

const BYTE_BUDGET = REPLY_SCAN_BYTE_BUDGET; // 1,048,576 for both scans

function syntheticStore(events, { mentions = [], state } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE rooms(id TEXT PRIMARY KEY);
    INSERT INTO rooms VALUES('room');
    CREATE TABLE events(room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));
    CREATE TABLE mention_states(room_id TEXT NOT NULL, message_event_id TEXT NOT NULL, mentioned_member_id TEXT NOT NULL, state TEXT NOT NULL, timeout_at INTEGER, PRIMARY KEY(room_id, message_event_id, mentioned_member_id));
    CREATE TABLE mention_observations(room_id TEXT NOT NULL, message_event_id TEXT NOT NULL, mentioned_member_id TEXT NOT NULL, acknowledged_at INTEGER, late_acknowledged_at INTEGER, PRIMARY KEY(room_id, message_event_id, mentioned_member_id));`);
  const insert = raw.prepare('INSERT INTO events VALUES(?,?,?,?)');
  for (const event of events) insert.run('room', event.sequence, event.id, event.body);
  const mention = raw.prepare('INSERT INTO mention_states VALUES(?,?,?,?,?)');
  for (const row of mentions) mention.run('room', row.eventId, row.memberId, row.state, 1000000);
  // Payload accounting in the probe's units: every row a query returns
  // whose body/id/eventId is a string counts the bytes that crossed.
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
  const store = {
    db,
    now: () => 0,
    state: roomState,
    room: () => ({ state: roomState }),
    readTransaction(fn) { return fn(); }
  };
  return { store, meter };
}

const posted = (sequence, data, actorId = 'writer') => ({
  sequence,
  id: `event-${sequence}`,
  body: JSON.stringify({ id: `event-${sequence}`, type: 'message.posted', actorId, data })
});

test('admission: an escaped batch is admitted under the byte budget, not transferred past it', () => {
  const events = [1, 2, 3].map(seq => posted(seq, { messageId: `event-${seq}`, body: ''.repeat(65536) }));
  const { store, meter } = syntheticStore(events);
  const scan = repliesOf(store, 'room', 'viewer', 0, 3, store.state);
  assert.ok(meter.payloadBytes <= BYTE_BUDGET,
    `payload transferred before admission: ${meter.payloadBytes}B crossed the byte budget`);
  assert.ok(scan.scannedBytes <= BYTE_BUDGET,
    `reported examined bytes crossed the budget: ${scan.scannedBytes}`);
  assert.equal(scan.exhausted, true, 'the scan stopped at the byte budget and says so');
  assert.equal(scan.scannedThrough, 2, 'the third event was left unfetched for the next read');
  assert.deepEqual(scan.items, []);
});

test('admission: a single legal escaped body is admitted whole', () => {
  const events = [posted(1, { messageId: 'event-1', body: ''.repeat(65536) })];
  const { store, meter } = syntheticStore(events);
  const scan = repliesOf(store, 'room', 'viewer', 0, 1, store.state);
  assert.equal(scan.scannedRows, 1);
  assert.equal(scan.exhausted, false);
  assert.ok(meter.payloadBytes > 393_000 && meter.payloadBytes < BYTE_BUDGET,
    `the legal body crossed once admitted (${meter.payloadBytes}B)`);
});

test('admission: an event larger than the whole byte budget refuses typed 503 before any payload fetch', () => {
  const events = [posted(1, { messageId: 'event-1', body: 'x'.repeat(BYTE_BUDGET + 1) })];
  const { store, meter } = syntheticStore(events);
  assert.throws(
    () => repliesOf(store, 'room', 'viewer', 0, 1, store.state),
    error => error?.status === 503 && error?.code === 'storage_unavailable',
    'the refusal is the typed storage_unavailable 503'
  );
  assert.equal(meter.payloadBytes, 0, 'the oversized payload never crossed into JS');
  assert.equal(meter.payloadRows, 0);
});

test('admission: the mention horizon refuses the same oversized event before payload fetch', () => {
  const events = [posted(1, { messageId: 'event-1', body: 'x'.repeat(BYTE_BUDGET + 1) })];
  const { store, meter } = syntheticStore(events);
  assert.throws(
    () => mentionHorizon(store, 'room', 'viewer', 0, 1),
    error => error?.status === 503 && error?.code === 'storage_unavailable'
  );
  assert.equal(meter.payloadBytes, 0);
});

test('admission: covered replies fetch no more payload rows than the examined-row budget', () => {
  const events = [];
  const mentions = [];
  for (let seq = 1; seq <= 1000; seq++) {
    events.push(posted(seq, { messageId: `event-${seq}`, body: 'covered reply', replyToId: 'parent' }));
    mentions.push({ eventId: `event-${seq}`, memberId: 'viewer', state: 'delivered' });
  }
  const state = { room: { id: 'room' }, messages: [{ id: 'parent', authorId: 'viewer', body: 'parent' }], replyRequests: {} };
  const { store, meter } = syntheticStore(events, { mentions, state });
  const scan = repliesOf(store, 'room', 'viewer', 0, 1000, state);
  assert.ok(meter.payloadRows <= 256,
    `${meter.payloadRows} payload rows fetched for ${scan.scannedRows} reported examined rows`);
  assert.equal(scan.scannedRows, 256, 'the examined count is the fetched count');
  assert.deepEqual(scan.items, [], 'every reply is mention-covered, so the kind stays empty');
});

test('admission: examined rows stay budget-bound as plain history grows', () => {
  for (const count of [320, 3200]) {
    const events = [];
    for (let seq = 1; seq <= count; seq++) events.push(posted(seq, { messageId: `event-${seq}`, body: 'plain post' }));
    const { store } = syntheticStore(events);
    const scan = repliesOf(store, 'room', 'viewer', 0, count, store.state);
    assert.equal(scan.scannedRows, 256, `at ${count} plain events the scan examines its budget, not the history`);
    assert.equal(scan.exhausted, true);
  }
});
