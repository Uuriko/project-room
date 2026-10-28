import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { getReadHorizon, setReadHorizon, ensureReadHorizonSchema } from '../server/activity.mjs';
import { DatabaseSync } from 'node:sqlite';
import { RoomClient } from '../src/client.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'horizon-revisions-'));
  const filename = join(dir, 'room.sqlite');
  let store = new RoomStore(filename, { now: () => 1000 });
  store.initialize(initialRoom('commons'));
  const key = store.issueAccessKey('commons', 'owner');
  store.command(key, 'commons', { id: 'post-first', type: 'message.posted', data: { messageId: 'first', body: 'A message' } });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get: (scope = {}) => getReadHorizon(store, key, 'commons', scope),
    set: data => setReadHorizon(store, key, 'commons', data),
    oldWriter: () => store.db.prepare(`INSERT INTO read_horizons(room_id,member_id,thread_id,last_read_message_id,updated_at)
      VALUES('commons','owner','','first',1000) ON CONFLICT(room_id,member_id,thread_id)
      DO UPDATE SET last_read_message_id=excluded.last_read_message_id,updated_at=excluded.updated_at`).run(),
    restart: () => { store.close(); store = new RoomStore(filename, { now: () => 500, integrity: 'deferred' }); },
  };
}
const conflict = fn => assert.throws(fn, error => error.status === 409 && error.code === 'horizon_conflict');

test('additive migration preserves legacy markers and is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE read_horizons(room_id TEXT,member_id TEXT,thread_id TEXT,last_read_message_id TEXT,updated_at INTEGER); INSERT INTO read_horizons VALUES('room','member','','message',42)");
    ensureReadHorizonSchema(db);
    ensureReadHorizonSchema(db);
    const row = db.prepare('SELECT * FROM read_horizons').get();
    assert.equal(row.last_read_message_id, 'message');
    assert.equal(row.updated_at, 42);
    assert.equal(row.revision, null);
    assert.equal(row.last_request_id, null);
  } finally { db.close(); }
});

test('acknowledged null-to-null rewind fences an older auto request delivered after transport failure', t => {
  const f = fixture(t), initial = f.get();
  const held = { expectedRevision: initial.revision, requestId: 'auto-held', lastReadMessageId: 'first' };
  const explicit = f.set({ expectedRevision: initial.revision, requestId: 'rewind', lastReadMessageId: null });
  assert.notEqual(explicit.revision, initial.revision);
  conflict(() => f.set(held));
  assert.equal(f.get().lastReadMessageId, null);
});

test('latest lost-success retry replays once; changed or superseded retries cannot mutate', t => {
  const f = fixture(t), initial = f.get();
  const command = { expectedRevision: initial.revision, requestId: 'advance', lastReadMessageId: 'first' };
  const accepted = f.set(command);
  const replay = f.set(command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, accepted.revision);
  assert.throws(() => f.set({ ...command, lastReadMessageId: null }), error => error.code === 'idempotency_conflict');
  const rewind = f.set({ expectedRevision: accepted.revision, requestId: 'rewind', lastReadMessageId: null });
  conflict(() => f.set(command));
  assert.equal(f.get().revision, rewind.revision);
});

test('one absent-row contender wins, revisions are scope-bound, legacy writes cannot bypass protection', t => {
  const f = fixture(t), initial = f.get();
  conflict(() => f.set({ threadId: 'another-thread', expectedRevision: initial.revision, requestId: 'cross-scope', lastReadMessageId: null }));
  f.set({ expectedRevision: initial.revision, requestId: 'one', lastReadMessageId: null });
  conflict(() => f.set({ expectedRevision: initial.revision, requestId: 'two', lastReadMessageId: 'first' }));
  assert.throws(() => f.set({ lastReadMessageId: 'first' }), error => error.status === 428);
});

test('legacy markers transition once and revisions/receipts survive restart and clock rollback', t => {
  const f = fixture(t);
  f.set({ lastReadMessageId: 'first' });
  const before = f.get();
  const command = { expectedRevision: before.revision, requestId: 'rewind', lastReadMessageId: null };
  const accepted = f.set(command);
  f.restart();
  assert.equal(f.get().revision, accepted.revision);
  assert.equal(f.set(command).replayed, true);
  assert.notEqual(f.set({ expectedRevision: accepted.revision, requestId: 'same-marker', lastReadMessageId: null }).revision, accepted.revision);
});

test('database rejects an older binary upsert after the conversation is protected', t => {
  const f = fixture(t);
  f.oldWriter();
  const before = f.get();
  f.set({ expectedRevision: before.revision, requestId: 'protect', lastReadMessageId: null });
  assert.throws(() => f.oldWriter(), /read-position revision must change/);
  assert.equal(f.get().lastReadMessageId, null);
  f.restart();
  assert.throws(() => f.oldWriter(), /read-position revision must change/);
  const current = f.get();
  assert.notEqual(f.set({ expectedRevision: current.revision, requestId: 'again', lastReadMessageId: null }).revision, current.revision);
});

test('client supplies a revision and never silently retries a conflict', async () => {
  const calls = [], conflictError = Object.assign(new Error('changed'), { status: 409 });
  const client = { generation: 1, session: {}, readHorizon: async () => ({ revision: 'a'.repeat(64) }),
    roomWrite: async (...args) => { calls.push(args); throw conflictError; } };
  await assert.rejects(RoomClient.prototype.setReadHorizon.call(client, '', null, 'alice'), error => error === conflictError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].expectedRevision, 'a'.repeat(64));
  assert.equal(calls[0][1].peerMemberId, 'alice');
  assert.match(calls[0][1].requestId, /^[a-f0-9-]+$/);
});

test('client does not write into a changed account session or downgrade against old servers', async () => {
  const client = { generation: 1, session: {}, roomWrite: () => { throw Error('must not write'); } };
  client.readHorizon = async () => { client.generation++; return { revision: 'a'.repeat(64) }; };
  assert.equal(await RoomClient.prototype.setReadHorizon.call(client, '', null), null);
  client.readHorizon = async () => ({ lastReadMessageId: null });
  await assert.rejects(RoomClient.prototype.setReadHorizon.call(client, '', null), /Refresh Project Room/);
});
