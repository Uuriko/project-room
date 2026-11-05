import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { exportNdjsonText, replayNdjson } from '../server/room-export.mjs';
import * as replay from '../server/replay-cutover.mjs';

function fixture(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize(initialRoom());
  store.db.exec(replay.replayCutoverSchema());
  const capture = requestId => replay.captureReplayWitness(store, {
    roomId: 'commons', requestId, expectedHead: store.headSequence('commons'),
    reason: 'Synthetic explicit replay lifecycle'
  });
  const captured = capture('capture');
  const input = { roomId: 'commons', generation: captured.generation,
    requestId: 'abandon', reason: 'Explicit synthetic abandonment' };
  return { store, captured, capture, input };
}
function serving(store) {
  return Object.fromEntries(['rooms', 'events', 'messages', 'projection_bodies', 'work_entities',
    'integrity_room_state', 'messages_backfill_cursor', 'messages_backfill_state',
    'message_replay_snapshots'].map(table => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]));
}

test('explicit abandonment changes only derived lifecycle and keeps original receipt historical', t => {
  const f = fixture(t), before = serving(f.store);
  const abandoned = replay.abandonReplayCapture(f.store, f.input);
  assert.equal(abandoned.lifecycle, 'abandoned');
  assert.equal(abandoned.certified, false);
  assert.deepEqual(serving(f.store), before);
  assert.throws(() => replay.advanceReplayWitness(f.store, {
    roomId: 'commons', generation: f.captured.generation, expectedBytes: 0, requestId: 'late-step'
  }), /abandoned|control/);
  assert.throws(() => f.capture('new-generation'), /completed candidate cleanup/);
  const cleanup = replay.cleanupReplayCapture(f.store, { roomId: 'commons', generation: f.captured.generation,
    expectedDeleted: 0, requestId: 'remove-unpublished-target' });
  assert.equal(cleanup.phase, 'target_cleanup');
  assert.ok(cleanup.targetRowsDeleted > 0);
  assert.deepEqual(serving(f.store), before);
  const next = f.capture('new-generation');
  assert.notEqual(next.generation, f.captured.generation);
  const duplicate = replay.abandonReplayCapture(f.store, f.input);
  assert.deepEqual({ ...duplicate, duplicate: false }, abandoned);
});

test('cleanup deletes at most 200 derived rows per atomic historical phase receipt', t => {
  const f = fixture(t), db = f.store.db, before = serving(f.store);
  const insert = db.prepare('INSERT INTO message_replay_units VALUES(?,?,?, ?,1,2,?,?)');
  for (let i = 0; i < 450; i++) {
    insert.run('commons', f.captured.generation, 'metadata-entry', 'synthetic-' + i, '', Buffer.from('{}'));
  }
  replay.abandonReplayCapture(f.store, f.input);
  let progress = { deleted: 0 }, first;
  for (let i = 0; !progress.done; i++) {
    const input = { roomId: 'commons', generation: f.captured.generation,
      expectedDeleted: progress.deleted, requestId: 'cleanup-' + i };
    progress = replay.cleanupReplayCapture(f.store, input);
    assert.ok(progress.rowsDeleted <= 200);
    if (!i) first = { input, result: progress };
  }
  assert.equal(db.prepare('SELECT 1 FROM message_replay_units WHERE generation=?')
    .get(f.captured.generation), undefined);
  assert.deepEqual(serving(f.store), before);
  const old = replay.cleanupReplayCapture(f.store, first.input);
  assert.deepEqual({ ...old, duplicate: false }, first.result);
});

test('abandonment audit storage fault rolls back pointer and all derived bytes', t => {
  const f = fixture(t), db = f.store.db;
  const before = db.prepare('SELECT * FROM message_replay_units').all();
  db.exec(`CREATE TRIGGER synthetic_abandon_audit_failure BEFORE INSERT ON operator_actions
    WHEN NEW.action='replay_cutover_abandon'
    BEGIN SELECT RAISE(ABORT,'synthetic abandon audit storage failure'); END`);
  assert.throws(() => replay.abandonReplayCapture(f.store, f.input), /synthetic abandon audit storage failure/);
  assert.deepEqual(db.prepare('SELECT * FROM message_replay_units').all(), before);
});

test('whole-store audit recognizes retained abandoned derivation without serving certification', t => {
  const f = fixture(t);
  replay.abandonReplayCapture(f.store, f.input);
  assert.equal(auditRecovery(f.store).checks.writerFence, true);
  assert.equal(replay.auditReplayCutoverRecovery(f.store.db).abandoned, 1);
});


test('cleanup receipt failure restores every already deleted row and progress', t => {
  const f = fixture(t), db = f.store.db;
  replay.abandonReplayCapture(f.store, f.input);
  const before = db.prepare('SELECT * FROM message_replay_units').all();
  db.exec(`CREATE TRIGGER synthetic_cleanup_audit_failure BEFORE INSERT ON operator_actions
    WHEN NEW.action='replay_cutover_cleanup'
    BEGIN SELECT RAISE(ABORT,'synthetic cleanup audit storage failure'); END`);
  assert.throws(() => replay.cleanupReplayCapture(f.store, {
    roomId: 'commons', generation: f.captured.generation, expectedDeleted: 0, requestId: 'cleanup-fault'
  }), /synthetic cleanup audit storage failure/);
  assert.deepEqual(db.prepare('SELECT * FROM message_replay_units').all(), before);
});

test('a valid abandonment receipt from a later generation cannot authorize old cleanup', t => {
  const f = fixture(t), db = f.store.db;
  replay.abandonReplayCapture(f.store, f.input);
  assert.throws(() => f.capture('later'), /completed candidate cleanup/);
  const cleanup = replay.cleanupReplayCapture(f.store, { roomId: 'commons', generation: f.captured.generation,
    expectedDeleted: 0, requestId: 'remove-unpublished-target' });
  assert.equal(cleanup.phase, 'target_cleanup');
  assert.equal(cleanup.done, false, 'old derived bytes still exist for the wrong-binding probe');
  const later = f.capture('later');
  replay.abandonReplayCapture(f.store, { ...f.input, generation: later.generation, requestId: 'later-abandon' });
  const pointer = db.prepare(`SELECT payload FROM message_replay_units
    WHERE generation=? AND domain='control' AND unit_key='abandonment'`).get(later.generation);
  db.prepare(`UPDATE message_replay_units SET payload=?
    WHERE generation=? AND domain='control' AND unit_key='abandonment'`)
    .run(pointer.payload, f.captured.generation);
  const before = db.prepare('SELECT * FROM message_replay_units').all();
  assert.throws(() => replay.cleanupReplayCapture(f.store, {
    roomId: 'commons', generation: f.captured.generation, expectedDeleted: 0, requestId: 'wrong-binding'
  }), /independent replay abandonment binding changed/);
  assert.deepEqual(db.prepare('SELECT * FROM message_replay_units').all(), before);
});

test('oversized lifecycle control refuses before payload transfer or any cleanup', t => {
  const f = fixture(t), db = f.store.db;
  replay.abandonReplayCapture(f.store, f.input);
  db.prepare(`UPDATE message_replay_units SET payload=?,payload_bytes=?
    WHERE generation=? AND domain='control' AND unit_key='abandonment'`)
    .run(Buffer.alloc(2 * 1024 * 1024), 2 * 1024 * 1024, f.captured.generation);
  assert.throws(() => replay.cleanupReplayCapture(f.store, {
    roomId: 'commons', generation: f.captured.generation, expectedDeleted: 0, requestId: 'oversized-control'
  }), /missing or invalid replay proof pointer/);
});


test('whole-store round trip retains abandoned lifecycle and exact historical receipt', t => {
  const f = fixture(t);
  const original = replay.abandonReplayCapture(f.store, f.input);
  const directory = mkdtempSync(join(tmpdir(), 'replay-abandoned-restore-'));
  const filename = join(directory, 'restored.sqlite');
  const result = replayNdjson(exportNdjsonText(f.store.db), filename);
  assert.equal(result.verified, true);
  const target = new RoomStore(filename);
  t.after(() => { target.close(); rmSync(directory, { recursive:true, force:true }); });
  assert.deepEqual(target.db.prepare('SELECT * FROM message_replay_units').all(),
    f.store.db.prepare('SELECT * FROM message_replay_units').all());
  const retried = replay.abandonReplayCapture(target, f.input);
  assert.deepEqual({ ...retried, duplicate: false }, original);
  assert.equal(replay.auditReplayCutoverRecovery(target.db).abandoned, 1);
});
