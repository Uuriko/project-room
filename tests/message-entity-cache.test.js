import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
function fixture(t, entities = true) {
  const store = new RoomStore(':memory:', { maintainMessageCertification: true,
    messageProjectionWindow: 20, messageEntityProjection: entities, verifyProjectionCache: false });
  t.after(() => store.close()); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  assert.equal(store.checkMessagesParity().ok, true);
  store.command(owner, 'commons', { id: 'post', type: 'message.posted', data: { messageId: 'kept', body: 'Original' } });
  assert.equal(store.room('commons').state.messages[0].body, 'Original');
  return store;
}
const update = "UPDATE main.\"messages\" SET body='Changed',record_json=json_set(record_json,'$.body','Changed') WHERE message_id='kept'";
for (const method of ['run', 'get', 'all', 'iterate', 'exec']) test(`entity mutation through ${method} refreshes a warm room`, t => {
  const s = fixture(t), warm = s.room('commons');
  if (method === 'exec') s.db.exec(update);
  else {
    const statement = s.db.prepare(update + ' RETURNING message_id');
    if (method === 'iterate') [...statement.iterate()]; else statement[method]();
  }
  const fresh = s.room('commons'); assert.equal(fresh.sequence, warm.sequence);
  assert.equal(fresh.state.messages[0].body, 'Changed'); assert.notEqual(fresh, warm);
});

test('mirror-row changes leave authoritative inline projections warm', t => {
  const s = fixture(t, false), warm = s.room('commons'); s.db.exec(update);
  assert.equal(s.room('commons'), warm); assert.equal(warm.state.messages[0].body, 'Original');
});

test('missing canonical entity cannot be hidden by a warm cache', t => {
  const s = fixture(t); s.db.prepare("DELETE FROM messages WHERE message_id='kept'").run();
  assert.throws(() => s.room('commons'), /projection_corrupt/);
});

test('a rolled-back entity update does not publish changed content', t => {
  const s = fixture(t);
  assert.throws(() => s.transaction(() => { s.db.exec(update); assert.equal(s.room('commons').state.messages[0].body, 'Changed'); throw Error('rollback'); }), /rollback/);
  assert.equal(s.room('commons').state.messages[0].body, 'Original');
});

test('existing entity carriers are watched even when the creation option is turned off', t => {
  const s = fixture(t); s.messageEntityProjection = false; s._dropProjectionCache(); s.room('commons');
  s.db.exec(update); assert.equal(s.room('commons').state.messages[0].body, 'Changed');
});

test('entity writes discard pending cache candidates and repopulate on the next read', t => {
  const s = fixture(t), owner = s.issueAccessKey('commons', 'owner');
  s.room('commons'); let reads = 0; const read = s._readProjection.bind(s);
  s._readProjection = (...args) => { reads++; return read(...args); };
  s.command(owner, 'commons', { id: 'next', type: 'message.posted', data: { messageId: 'next', body: 'Next' } });
  const before = reads; assert.equal(s.room('commons').state.messages.at(-1).body, 'Next');
  assert.equal(reads, before + 1, 'later mutations must discard pending entity candidates');
  s.room('commons'); assert.equal(reads, before + 1, 'unchanged reads remain warm');
});

test('comment-separated mutations and trigger writes invalidate entity caches', t => {
  const s = fixture(t); s.db.exec("CREATE TABLE entity_repair(value TEXT); CREATE TRIGGER apply_entity_repair AFTER INSERT ON entity_repair BEGIN UPDATE messages SET body=NEW.value,record_json=json_set(record_json,'$.body',NEW.value) WHERE message_id='kept'; END");
  s.room('commons'); s.db.prepare(update.replace('UPDATE main.', 'UPDATE /* maintenance */ main.')).run();
  assert.equal(s.room('commons').state.messages[0].body, 'Changed');
  s.db.prepare('INSERT INTO entity_repair VALUES(?)').run('Triggered');
  assert.equal(s.room('commons').state.messages[0].body, 'Triggered');
});

test('unchanged transactional reads retain their hydrated entity cache', t => {
  const s = fixture(t); let reads = 0; const read = s._readProjection.bind(s);
  s._readProjection = (...args) => { reads++; return read(...args); };
  s.readTransaction(() => s.room('commons')); const before = reads;
  s.readTransaction(() => s.room('commons')); assert.equal(reads, before);
});
