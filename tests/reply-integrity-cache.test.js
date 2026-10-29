import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { event } from '../src/events.js';
import { initialRoom } from '../server/bootstrap.mjs';

function fixture(t, path = ':memory:') {
  const store = new RoomStore(path); t.after(() => store.close());
  store.initialize(initialRoom()); const owner = store.issueAccessKey('commons', 'owner');
  store.command(owner, 'commons', { id: 'reader', type: 'member.added', data: { memberId: 'reader', displayName: 'Reader', kind: 'human', permissions: [] } });
  const reader = store.issueAccessKey('commons', 'reader');
  store.dmConsents.request('commons', 'owner', 'reader', 'Test'); store.dmConsents.decide('commons', 'reader', 'owner', 'approve');
  store.command(owner, 'commons', { id: 'ask', type: 'message.posted', data: { messageId: 'ask', body: 'Question', toMemberId: 'reader', requestKind: 'reply' } });
  let scans = 0; const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { if (sql.includes('FROM events WHERE room_id=? ORDER BY sequence LIMIT 128')) scans++; return prepare(sql); };
  return { store, reader, owner, read: () => store.replyRequests.selected(reader, 'commons', 'ask'), scans: () => scans };
}

test('unchanged reads reuse integrity while selected content and authentication stay live', t => {
  const f = fixture(t); assert.equal(f.read().page.items[0].message.body, 'Question');
  assert.equal(f.scans(), 1); f.read(); assert.equal(f.scans(), 1);
  assert.throws(() => f.store.replyRequests.selected('invalid', 'commons', 'ask'), /access|token|credential|key|Unauthenticated/i);
  assert.equal(f.scans(), 1);
});

test('same-sequence event corruption invalidates prior integrity', t => {
  const f = fixture(t); f.read();
  f.store.db.prepare("UPDATE events SET body=json_set(body,'$.id','corrupt') WHERE room_id='commons' AND sequence=2").run();
  assert.throws(f.read, error => error.code === 'reply_history_changed');
  assert.equal(f.scans(), 2);
});

test('nested reads and writes neither reuse nor publish integrity', t => {
  const f = fixture(t); f.read();
  f.store.readTransaction(f.read); f.store.transaction(f.read); assert.equal(f.scans(), 3);
  f.read(); assert.equal(f.scans(), 3);
  const g = fixture(t); g.store.readTransaction(g.read); g.read(); assert.equal(g.scans(), 2);
});

test('an exception at the outer read boundary prevents publication', t => {
  const f = fixture(t), original = f.store.readTransaction.bind(f.store);
  f.store.readTransaction = fn => original(() => { fn(); throw Error('commit boundary fault'); });
  assert.throws(f.read, /commit boundary fault/);
  f.store.readTransaction = original; f.read(); assert.equal(f.scans(), 2);
});

test('rolled-back same-head changes cannot publish abandoned integrity', t => {
  const f = fixture(t); f.read();
  assert.throws(() => f.store.transaction(() => {
    f.store.db.prepare("UPDATE events SET body=json_set(body,'$.id','corrupt') WHERE room_id='commons' AND sequence=2").run();
    assert.throws(f.read, error => error.code === 'reply_history_changed');
    throw Error('rollback');
  }), /rollback/);
  assert.equal(f.read().page.items[0].message.body, 'Question');
  assert.equal(f.scans(), 3);
});


test('external same-head projection writes invalidate both integrity and stale projection', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reply-integrity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, 'db.sqlite'));
  const other = new RoomStore(join(dir, 'db.sqlite')); t.after(() => other.close());
  assert.equal(f.read().preparation.room.title, 'Project Room Commons');
  other.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','Fresh external title') WHERE id='commons'").run();
  assert.equal(f.read().preparation.room.title, 'Fresh external title');
  assert.equal(f.scans(), 2);
});

test('schema changes invalidate a prior read even without DML changes', t => {
  const f = fixture(t); f.read();
  f.store.db.exec('CREATE TABLE cache_probe(value TEXT)');
  f.read(); assert.equal(f.scans(), 2);
  f.store.db.exec('DROP TABLE cache_probe');
  f.read(); assert.equal(f.scans(), 3);
});


test('first eligible read refreshes a projection warmed by another API before external change', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reply-first-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, 'db.sqlite'));
  const other = new RoomStore(join(dir, 'db.sqlite')); t.after(() => other.close());
  f.store.room('commons');
  other.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','External first read') WHERE id='commons'").run();
  assert.equal(f.read().preparation.room.title, 'External first read');
});

test('cache hit still enforces viewer selection and does not expose mutable cached response', t => {
  const f = fixture(t), first = f.read();
  first.page.items[0].message.body = 'Caller mutation'; first.request.status = 'cancelled';
  assert.equal(f.read().page.items[0].message.body, 'Question');
  assert.equal(f.read().request.status, 'open'); assert.equal(f.scans(), 1);
  const ownerRead = f.store.replyRequests.selected(f.owner, 'commons', 'ask');
  assert.equal(ownerRead.current.answerBasis, null); assert.equal(f.scans(), 1);
});

test('fresh-horizon integrity cannot certify an older continuation', t => {
  const f = fixture(t);
  const post = n => f.store.command(f.owner, 'commons', { id: `context-${n}`, type: 'message.posted',
    data: { messageId: `context-${n}`, body: `Context ${n}`, replyToId: 'ask', toMemberId: 'reader' } });
  post(1); post(2);
  const first = f.store.replyRequests.selected(f.reader, 'commons', 'ask', { limit: 1 });
  assert.ok(first.page.nextCursor); post(3); f.read();
  const before = f.scans();
  const resumed = f.store.replyRequests.selected(f.reader, 'commons', 'ask', { cursor: first.page.nextCursor });
  assert.equal(f.scans(), before + 1);
  assert.equal(resumed.page.horizonSequence, first.page.horizonSequence);
  assert.ok(resumed.page.items.every(item => item.sequence <= first.page.horizonSequence));
});

test('an unrelated viewer cannot read a private request from a cached integrity index', t => {
  const f = fixture(t);
  f.store.command(f.owner, 'commons', { id: 'outsider', type: 'member.added', data: {
    memberId: 'outsider', displayName: 'Outsider', kind: 'human', permissions: [] } });
  const outsider = f.store.issueAccessKey('commons', 'outsider'); f.read();
  assert.throws(() => f.store.replyRequests.selected(outsider, 'commons', 'ask'), error => error.code === 'reply_request_not_found');
  assert.equal(f.scans(), 1);
});


test('oversized integrity stays uncached and still refreshes external same-head changes', t => {
  const base = fixture(t);
  const seed = base.store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all().map(row => JSON.parse(row.body));
  for (let i = 0; i < 5000; i++) seed.push(event({ type: 'message.posted', roomId: 'commons', actorId: 'owner',
    data: { messageId: `large-${i}-` + 'x'.repeat(110), body: 'Context', replyToId: 'ask', toMemberId: 'reader' } }));
  const dir = mkdtempSync(join(tmpdir(), 'reply-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RoomStore(join(dir, 'db.sqlite')); t.after(() => store.close()); store.initialize(seed);
  const reader = store.issueAccessKey('commons', 'reader');
  let scans = 0; const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { if (sql.includes('FROM events WHERE room_id=? ORDER BY sequence LIMIT 128')) scans++; return prepare(sql); };
  const read = () => store.replyRequests.selected(reader, 'commons', 'ask', { limit: 1 });
  read(); read(); assert.equal(scans, 2, 'oversized index must not be reused');
  const other = new RoomStore(join(dir, 'db.sqlite')); t.after(() => other.close());
  other.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','External after oversized read') WHERE id='commons'").run();
  assert.equal(read().preparation.room.title, 'External after oversized read');
  assert.equal(scans, 3);
});
