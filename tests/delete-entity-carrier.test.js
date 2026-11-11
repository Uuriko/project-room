import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

function fixture(t, { entities = true, bodiesAtRest = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'delete-entities-'));
  const path = join(dir, 'room.sqlite');
  const options = { maintainMessageCertification: true, messageProjectionWindow: 100,
    messageEntityProjection: entities, bodiesAtRest };
  const store = new RoomStore(path, options);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  let now = Date.now() + 10000; store.now = () => now;
  const send = (type, data, id = crypto.randomUUID()) => {
    now += 2001; return store.command(owner, 'commons', { id, type, data });
  };
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  assert.equal(store.checkMessagesParity().ok, true);
  const post = (messageId, extra = {}) => send('message.posted', { messageId, body: messageId + ' content '.repeat(300), ...extra });
  post('root'); post('target', { replyToId: 'root', alsoSendToChannel: true }); post('kept');
  const raw = () => JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  const del = (messageId = 'target', id = crypto.randomUUID()) => send('message.deleted', { messageId, expectedMessageRevision: 0 }, id);
  return { store, path, options, raw, del };
}

for (const bodiesAtRest of [false, true]) test(`delete preserves unrelated entities through both writes and reopen (bodies=${bodiesAtRest})`, t => {
  const f = fixture(t, { bodiesAtRest });
  f.store.db.exec(`CREATE TABLE projection_sizes(bytes INTEGER, messages TEXT);
    CREATE TRIGGER observe_projection AFTER UPDATE OF projection ON rooms BEGIN
      INSERT INTO projection_sizes VALUES(length(NEW.projection), json_extract(NEW.projection,'$.messages')); END`);
  f.del('target', 'delete-once');
  const raw = f.raw();
  assert.deepEqual(raw.messages.filter(m => m._entity === 1).map(m => m.id), ['root', 'kept']);
  assert.ok(raw.messages.filter(m => m.id.startsWith('target')).every(m => !m._entity && m.body === null));
  for (const row of f.store.db.prepare('SELECT * FROM projection_sizes').all()) {
    const unrelated = JSON.parse(row.messages).filter(m => ['root', 'kept'].includes(m.id));
    assert.deepEqual(unrelated, [{ id: 'root', _entity: 1 }, { id: 'kept', _entity: 1 }],
      'neither projection write expands unrelated message bodies');
  }
  assert.equal(f.del('target', 'delete-once').duplicate, true);
  assert.equal(f.store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='commons'").get().parity_at_seq, null);
  const expected = f.store.room('commons').state.messages;
  f.store.close();
  const reopened = new RoomStore(f.path, f.options); t.after(() => reopened.close());
  assert.deepEqual(reopened.room('commons').state.messages, expected);
  while (!reopened.backfillMessages({ limit: 1000 }).done) { /* recovery */ }
  assert.equal(reopened.checkMessagesParity().ok, true);
});

test('copy-only deletion retains source and repeated deletion retains only existing refs', t => {
  const f = fixture(t); f.del('target:channel');
  assert.equal(f.raw().messages.find(m => m.id === 'target')._entity, 1);
  assert.ok(f.store.room('commons').state.messages.find(m => m.id === 'target').body.startsWith('target'));
  f.del('kept');
  assert.deepEqual(f.raw().messages.filter(m => m._entity === 1).map(m => m.id), ['root', 'target']);
  assert.equal(f.raw().messages.find(m => m.id === 'target:channel')._entity, undefined);
});

test('deletion never promotes an inline carrier', t => {
  const f = fixture(t, { entities: false }); f.store.messageEntityProjection = true;
  f.del(); assert.ok(f.raw().messages.every(m => m._entity !== 1));
});

for (const [name, mutation] of [
  ['missing', "DELETE FROM messages WHERE message_id='kept'"],
  ['malformed', "UPDATE messages SET reducer_extras_json='broken' WHERE message_id='kept'"],
  ['changed', "UPDATE messages SET body='changed',record_json=json_set(record_json,'$.body','changed') WHERE message_id='kept'"]
]) test(`deletion rolls back if an unrelated entity becomes ${name} inside its transaction`, t => {
  const f = fixture(t); const before = f.raw(); const head = f.store.headSequence('commons');
  f.store.room('commons');
  f.store.db.exec(`CREATE TRIGGER mutate_during_delete AFTER INSERT ON events
    WHEN json_extract(NEW.body,'$.type')='message.deleted' BEGIN ${mutation}; END`);
  assert.throws(() => f.del('target', 'retry'), /projection_corrupt/);
  assert.deepEqual(f.raw(), before); assert.equal(f.store.headSequence('commons'), head);
  f.store.db.exec('DROP TRIGGER mutate_during_delete');
  assert.equal(f.del('target', 'retry').duplicate, false);
  assert.equal(f.del('target', 'retry').duplicate, true);
});

test('final projection failure rolls back log scrubbing, entities and receipt', t => {
  const f = fixture(t); const before = f.raw(); const head = f.store.headSequence('commons');
  const events = f.store.db.prepare('SELECT * FROM events ORDER BY sequence').all();
  f.store.db.exec(`CREATE TRIGGER fail_final BEFORE UPDATE ON rooms WHEN NEW.sequence > ${head + 1}
    BEGIN SELECT RAISE(ABORT,'final write fault'); END`);
  assert.throws(() => f.del('target', 'retry-final'), /final write fault/);
  assert.deepEqual(f.raw(), before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM events ORDER BY sequence').all(), events);
  f.store.db.exec('DROP TRIGGER fail_final'); f.del('target', 'retry-final');
  f.store._dropProjectionCache();
  assert.equal(f.store.room('commons').state.messages.find(m => m.id === 'target').body, null);
});
