import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialRoom } from '../server/bootstrap.mjs';
import { replay, event, applyEvent } from '../src/events.js';
import { writeMessageReplaySnapshot, decodeMessageReplaySnapshot, MESSAGE_REPLAY_SNAPSHOT_SCHEMA } from '../server/message-replay-snapshot.mjs';
import { schema, step, digest, limits } from '../scripts/prototypes/bounded-replay-staging.mjs';

function fixture(path = ':memory:', count = 1) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE rooms(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL);
    CREATE TABLE events(room_id TEXT,sequence INTEGER,id TEXT,body TEXT,PRIMARY KEY(room_id,sequence));
    CREATE TABLE messages_backfill_cursor(room_id TEXT PRIMARY KEY,applied_seq INTEGER,applied_event_id TEXT,state_seq INTEGER,replay_event_id TEXT,parity_at_seq INTEGER);`);
  db.exec(schema);
  db.exec(MESSAGE_REPLAY_SNAPSHOT_SCHEMA);
  const { messages, eventLog, seenEvents, seenIdempotencyKeys, ...metadata } = replay(initialRoom());
  const anchor = event({ type: 'message.posted', roomId: 'commons', actorId: 'owner', id: 'seed', data: { messageId: 'm0', body: 'seed' } });
  db.prepare('INSERT INTO rooms VALUES (?,?)').run('commons', 1);
  db.prepare('INSERT INTO events VALUES (?,?,?,?)').run('commons', 1, anchor.id, JSON.stringify(anchor));
  db.prepare('INSERT INTO messages_backfill_cursor VALUES (?,?,?,?,?,?)').run('commons', 0, '', 1, anchor.id, null);
  const text = JSON.stringify(metadata);
  db.prepare('INSERT INTO message_replay_formats VALUES (?,1,?,?,?)').run('commons', text, digest(text), digest(JSON.stringify(anchor)));
  const insert = db.prepare('INSERT INTO message_replay_units VALUES (?,?,?,?)');
  const all = [];
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const message = { id: `m${i}`, authorId: 'owner', body: `seed ${'x'.repeat(256)}`, revision: 0, at: '2026-11-01T00:00:00Z' };
    const json = JSON.stringify(message);
    insert.run('commons', message.id, json, digest(json));
    all.push(message);
  }
  db.exec('COMMIT');
  return { db, metadata, all };
}
function append(db, revision = 0, type = 'message.edited', extra = {}) {
  const seq = db.prepare('SELECT sequence FROM rooms').get().sequence + 1;
  const incoming = event({ id: `e${seq}`, type, actorId: 'owner', roomId: 'commons', at: '2026-11-01T00:00:01Z', data: { messageId: 'm0', body: `edit-${seq}`, expectedMessageRevision: revision, ...extra } });
  db.prepare('INSERT INTO events VALUES (?,?,?,?)').run('commons', seq, incoming.id, JSON.stringify(incoming));
  db.prepare('UPDATE rooms SET sequence=?').run(seq);
  return incoming;
}
function run(db, fault) {
  const census = { sizeRows: 0, payloadRows: 0, payloadBytes: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = step(db, 'commons', census);
    fault?.();
    db.exec('COMMIT');
    return { result, census };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function read(db) { return JSON.parse(db.prepare("SELECT json FROM message_replay_units WHERE message_id='m0'").get().json); }
function cursor(db) { return db.prepare('SELECT * FROM messages_backfill_cursor').get(); }

test('real legacy decoder exceeds the fixed payload budget; point staging stays constant at 1k/10k/100k', () => {
  const measurements = [];
  for (const count of [1000, 10000, 100000]) {
    const f = fixture(':memory:', count);
    try {
      const json = JSON.stringify({ ...f.metadata, messages: f.all });
      writeMessageReplaySnapshot(f.db, 'commons', json);
      const manifest = f.db.prepare('SELECT state_json FROM message_replay_snapshots WHERE room_id=?').get('commons').state_json;
      let legacyBytes = Buffer.byteLength(manifest), legacyParts = 0;
      const monitored = { prepare(sql) { const statement = f.db.prepare(sql); return {
        all(...args) { const rows = statement.all(...args); for (const row of rows) { legacyParts++; legacyBytes += Buffer.byteLength(row.json); } return rows; }
      }; } };
      assert.equal(decodeMessageReplaySnapshot(monitored, 'commons', manifest).messages.length, count);
      const incoming = append(f.db);
      const expected = applyEvent({ ...f.metadata, messages: f.all, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }, incoming).messages[0];
      const { result, census } = run(f.db);
      assert.equal(result.advanced, true);
      assert.deepEqual(read(f.db), expected);
      assert.equal(census.payloadRows, 4);
      assert.ok(census.payloadBytes <= limits.metadata + limits.message + limits.event * 2);
      assert.equal(cursor(f.db).applied_seq, 0, 'staging does not publish');
      measurements.push({ count, legacyBytes, legacyParts, ...census });
      if (process.env.BOUNDED_REPLAY_LEGACY_CONTROL === '1') {
        assert.ok(legacyBytes <= limits.metadata + limits.message + limits.event * 2,
          `legacy full hydration transfers ${legacyBytes} bytes; fixed budget is ${limits.metadata + limits.message + limits.event * 2}`);
      }
    } finally { f.db.close(); }
  }
  assert.equal(new Set(measurements.map(m => m.payloadBytes)).size, 1);
  assert.ok(measurements[2].legacyBytes > measurements[0].legacyBytes * 90);
  console.log('SYNTHETIC_REPLAY_RESOURCE_CENSUS', JSON.stringify(measurements));
});

test('durable staging progresses across real SQLite close/reopen and continuous appends', t => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-format-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, 'state.sqlite');
  let { db } = fixture(path, 1000);
  try {
    for (let revision = 0; revision < 10; revision++) {
      append(db, revision);
      const { result } = run(db);
      assert.equal(result.advanced, true);
      assert.equal(result.certified, false);
      assert.equal(result.publication, 'pending');
      assert.equal(cursor(db).state_seq, revision + 2);
      db.close(); db = new DatabaseSync(path);
    }
    assert.equal(read(db).revision, 10);
    assert.equal(run(db).result.reason, 'publication-not-implemented');
    assert.equal(cursor(db).applied_seq, 0);
  } finally { db.close(); }
});

test('fault after writes rolls message, event digest and existing cursor back together', () => {
  const { db } = fixture();
  try {
    append(db);
    const before = { cursor: cursor(db), message: read(db), header: db.prepare('SELECT * FROM message_replay_formats').get() };
    assert.throws(() => run(db, () => { throw new Error('crash-before-commit'); }), /crash-before-commit/);
    assert.deepEqual(cursor(db), before.cursor);
    assert.deepEqual(read(db), before.message);
    assert.deepEqual(db.prepare('SELECT * FROM message_replay_formats').get(), before.header);
    assert.equal(run(db).result.advanced, true);
  } finally { db.close(); }
});

for (const mutation of ['anchor-id', 'same-sequence-body', 'message', 'metadata']) {
  test(`corruption refuses without advancing: ${mutation}`, () => {
    const { db } = fixture();
    try {
      append(db);
      if (mutation === 'anchor-id') db.prepare("UPDATE events SET id='other' WHERE sequence=1").run();
      if (mutation === 'same-sequence-body') db.prepare("UPDATE events SET body=replace(body,'seed','evil') WHERE sequence=1").run();
      if (mutation === 'message') db.prepare("UPDATE message_replay_units SET json=replace(json,'seed','evil')").run();
      if (mutation === 'metadata') db.prepare("UPDATE message_replay_formats SET metadata_json=replace(metadata_json,'commons','evil')").run();
      assert.throws(() => run(db), /changed|corrupt/);
      assert.equal(cursor(db).state_seq, 1);
    } finally { db.close(); }
  });
}

for (const family of ['message.posted', 'member.added', 'message.redacted', 'message.deleted']) {
  test(`unsupported family remains pending: ${family}`, () => {
    const { db } = fixture();
    try {
      append(db, 0, family);
      assert.equal(run(db).result.reason, 'unsupported-event-family');
      assert.equal(cursor(db).state_seq, 1);
    } finally { db.close(); }
  });
}

test('UTF-8 event oversize refuses before transferring the event or target payload', () => {
  const { db } = fixture();
  try {
    append(db, 0, 'message.edited', { body: '🦉'.repeat(10000) });
    const { result, census } = run(db);
    assert.equal(result.reason, 'event-byte-limit');
    assert.equal(census.payloadRows, 2, 'only metadata and previous anchor transferred');
    assert.equal(cursor(db).state_seq, 1);
  } finally { db.close(); }
});

for (const unit of ['metadata', 'message']) {
  test(`oversized ${unit} refuses before its payload crosses into JavaScript`, () => {
    const { db } = fixture();
    try {
      append(db);
      if (unit === 'metadata') db.prepare('UPDATE message_replay_formats SET metadata_json=?').run(' '.repeat(limits.metadata + 1));
      else db.prepare('UPDATE message_replay_units SET json=?').run(' '.repeat(limits.message + 1));
      assert.throws(() => run(db), /unit-byte-limit/);
      assert.equal(cursor(db).state_seq, 1);
    } finally { db.close(); }
  });
}

test('bounded edit preserves common reducer metadata defaults', () => {
  const f = fixture();
  try {
    const metadata = { ...f.metadata, channels: {} };
    const json = JSON.stringify(metadata);
    f.db.prepare('UPDATE message_replay_formats SET metadata_json=?,metadata_sha=?').run(json, digest(json));
    const incoming = append(f.db);
    const expected = applyEvent({ ...metadata, messages: f.all, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }, incoming);
    run(f.db);
    const stored = JSON.parse(f.db.prepare('SELECT metadata_json FROM message_replay_formats').get().metadata_json);
    assert.deepEqual(stored.channels, expected.channels);
    assert.ok(Object.keys(stored.channels).length > 0);
  } finally { f.db.close(); }
});

test('oversized reducer output stays pending and writes no staging/cursor data', () => {
  const { db } = fixture();
  try {
    const message = read(db);
    message.body = 'b'.repeat(30000);
    message.other = 'x'.repeat(95000);
    const json = JSON.stringify(message);
    assert.ok(Buffer.byteLength(json) < limits.message);
    db.prepare('UPDATE message_replay_units SET json=?,sha=?').run(json, digest(json));
    append(db, 0, 'message.edited', { body: 'c'.repeat(20000) });
    const before = cursor(db);
    assert.equal(run(db).result.reason, 'output-byte-limit');
    assert.deepEqual(cursor(db), before);
    assert.deepEqual(read(db), message);
  } finally { db.close(); }
});

for (const context of ['archive', 'published', 'reply']) {
  test(`unqualified context stays pending: ${context}`, () => {
    const f = fixture();
    try {
      append(f.db);
      if (context === 'reply') {
        const message = { ...read(f.db), replyToId: 'parent' };
        const json = JSON.stringify(message);
        f.db.prepare('UPDATE message_replay_units SET json=?,sha=?').run(json, digest(json));
      } else {
        const metadata = f.metadata;
        if (context === 'archive') metadata.messagesArchive = { throughSeq: 1, count: 1, retainedIds: [] };
        else metadata.room.publicPage = { enabled: true };
        const json = JSON.stringify(metadata);
        f.db.prepare('UPDATE message_replay_formats SET metadata_json=?,metadata_sha=?').run(json, digest(json));
      }
      assert.match(run(f.db).result.reason, /unsupported-.*context/);
      assert.equal(cursor(f.db).state_seq, 1);
    } finally { f.db.close(); }
  });
}

test('a log gap does not skip sequence or publish a prefix', () => {
  const { db } = fixture();
  try {
    append(db);
    db.prepare('UPDATE events SET sequence=3 WHERE sequence=2').run();
    assert.equal(run(db).result.reason, 'event-gap');
    assert.equal(cursor(db).state_seq, 1);
  } finally { db.close(); }
});

test('metadata/unit lookups and next-event admission use indexed searches', () => {
  const { db } = fixture();
  try {
    const queries = [
      ["SELECT length(CAST(json AS BLOB)) FROM message_replay_units WHERE room_id=? AND message_id=?", ['commons', 'm0']],
      ["SELECT length(CAST(metadata_json AS BLOB)) FROM message_replay_formats WHERE room_id=?", ['commons']],
      ["SELECT sequence,length(CAST(body AS BLOB)) FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1", ['commons', 1]]
    ];
    for (const [sql, args] of queries) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
      assert.ok(plan.every(row => !/SCAN|TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
      assert.ok(plan.some(row => /SEARCH .*INDEX/.test(row.detail)), JSON.stringify(plan));
    }
  } finally { db.close(); }
});

for (const control of ['state_seq', 'head', 'next_sequence', 'cursor_id', 'anchor_id', 'next_id', 'format_version', 'metadata_sha', 'event_sha', 'message_sha']) {
  test(`stored control ${control} corruption refuses before transferring a 2MiB scalar`, () => {
    const { db } = fixture();
    try {
      append(db);
      const oversized = 'x'.repeat(2 * 1024 * 1024);
      if (control === 'state_seq') db.prepare('UPDATE messages_backfill_cursor SET state_seq=?').run(oversized);
      if (control === 'head') db.prepare('UPDATE rooms SET sequence=?').run(oversized);
      if (control === 'next_sequence') db.prepare('UPDATE events SET sequence=? WHERE sequence=2').run(oversized);
      if (control === 'cursor_id') db.prepare('UPDATE messages_backfill_cursor SET replay_event_id=?').run(oversized);
      if (control === 'anchor_id') db.prepare('UPDATE events SET id=? WHERE sequence=1').run(oversized);
      if (control === 'next_id') db.prepare('UPDATE events SET id=? WHERE sequence=2').run(oversized);
      if (control === 'format_version') {
        db.exec('PRAGMA ignore_check_constraints=ON');
        db.prepare('UPDATE message_replay_formats SET version=?').run(oversized);
      }
      if (control === 'metadata_sha') db.prepare('UPDATE message_replay_formats SET metadata_sha=?').run(oversized);
      if (control === 'event_sha') db.prepare('UPDATE message_replay_formats SET event_sha=?').run(oversized);
      if (control === 'message_sha') db.prepare('UPDATE message_replay_units SET sha=?').run(oversized);
      let maxReturnedBytes = 0;
      const guarded = { get isTransaction() { return db.isTransaction; }, prepare(sql) {
        const statement = db.prepare(sql);
        return { get(...args) {
          const row = statement.get(...args);
          for (const value of Object.values(row ?? {})) if (typeof value === 'string' || Buffer.isBuffer(value)) {
            maxReturnedBytes = Math.max(maxReturnedBytes, Buffer.byteLength(value));
          }
          return row;
        } };
      } };
      db.exec('BEGIN');
      let outcome;
      try { outcome = step(guarded, 'commons'); } catch (error) { outcome = { refused: error.message }; }
      finally { db.exec('ROLLBACK'); }
      assert.ok(!outcome.advanced);
      assert.ok(maxReturnedBytes <= limits.message,
        `unadmitted control crossed SQLite/JS boundary: ${maxReturnedBytes} bytes`);
      assert.equal(read(db).revision, 0);
    } finally { db.close(); }
  });
}

test('full reducer and point edit agree with an existing top-level companion; companion stays unchanged', () => {
  const f = fixture();
  try {
    // A top-level post does not normally create this copy, but imported/legacy
    // shape must not make the point context diverge from the actual reducer.
    const copy = { ...f.all[0], id: 'm0:channel', body: 'independent companion body' };
    const json = JSON.stringify(copy);
    f.db.prepare('INSERT INTO message_replay_units VALUES (?,?,?,?)').run('commons', copy.id, json, digest(json));
    const incoming = append(f.db, 0, 'message.edited', { alsoSendToChannel: true });
    const expected = applyEvent({ ...f.metadata, messages: [...f.all, copy], eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }, incoming).messages;
    assert.deepEqual(expected[1], copy, 'actual edit handler does not rewrite a companion');
    assert.equal(run(f.db).result.advanced, true);
    const actual = f.db.prepare('SELECT json FROM message_replay_units ORDER BY message_id').all().map(row => JSON.parse(row.json));
    assert.deepEqual(actual, expected);
  } finally { f.db.close(); }
});

test('real reducer crosspost source and copy stay pending without advancing or changing either row', () => {
  const f = fixture();
  try {
    const post = event({ id: 'crosspost', roomId: 'commons', actorId: 'owner', type: 'message.posted', data: { messageId: 'reply', replyToId: 'm0', alsoSendToChannel: true, body: 'crossposted reply' } });
    const state = applyEvent({ ...f.metadata, messages: f.all, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }, post);
    assert.ok(state.messages.find(message => message.id === 'reply').replyToId);
    assert.equal(state.messages.find(message => message.id === 'reply:channel').replyToId, null);
    for (const message of state.messages.slice(1)) {
      const json = JSON.stringify(message);
      f.db.prepare('INSERT INTO message_replay_units VALUES (?,?,?,?)').run('commons', message.id, json, digest(json));
    }
    const before = f.db.prepare('SELECT * FROM message_replay_units ORDER BY message_id').all();
    for (const id of ['reply', 'reply:channel']) {
      f.db.prepare('DELETE FROM events WHERE sequence=2').run();
      f.db.prepare('UPDATE rooms SET sequence=1').run();
      append(f.db, 0, 'message.edited', { messageId: id });
      assert.equal(run(f.db).result.reason, 'unsupported-message-context');
      assert.equal(cursor(f.db).state_seq, 1);
      assert.deepEqual(f.db.prepare('SELECT * FROM message_replay_units ORDER BY message_id').all(), before);
    }
  } finally { f.db.close(); }
});
