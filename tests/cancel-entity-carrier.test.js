import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { auditRecovery } from '../server/recovery.mjs';

function fixture(t, entities = true) {
  const store = new RoomStore(':memory:', { maintainMessageCertification: true,
    messageProjectionWindow: 100, messageEntityProjection: entities });
  t.after(() => store.close()); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  const send = (type, data, id = crypto.randomUUID()) => store.command(owner, 'commons', { id, type, data });
  send('member.added', { memberId: 'reader', kind: 'human', displayName: 'Reader', permissions: [] });
  store.dmConsents.request('commons', 'owner', 'reader', 'Fixture');
  store.dmConsents.decide('commons', 'reader', 'owner', 'approve');
  while (!store.backfillMessages({ limit: 1000 }).done) { /* bounded fixture */ }
  assert.equal(store.checkMessagesParity().ok, true);
  send('message.posted', { messageId: 'ask', body: 'Question ' + 'x'.repeat(2000), toMemberId: 'reader', requestKind: 'reply' });
  const raw = () => JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  const certificate = () => ({ ...store.db.prepare("SELECT * FROM messages_backfill_cursor WHERE room_id='commons'").get() });
  const cancel = id => send('reply_request.cancelled', { requestMessageId: 'ask', expectedRequestRevision: 0, reason: 'Resolved' }, id);
  return { store, raw, certificate, cancel };
}

test('cancellation preserves existing entities without promoting the parity certificate', t => {
  const f = fixture(t), before = f.certificate(), messages = f.store.room('commons').state.messages;
  assert.equal(f.raw().messages[0]._entity, 1);
  f.cancel('cancel');
  assert.equal(f.raw().messages[0]._entity, 1);
  assert.deepEqual(f.store.room('commons').state.messages, messages);
  assert.deepEqual(f.certificate(), before);
  assert.notEqual(f.certificate().parity_at_seq, f.store.headSequence('commons'));
  assert.equal(f.cancel('cancel').duplicate, true);
  while (!f.store.backfillMessages({ limit: 1000 }).done) { /* replay unsupported transition */ }
  assert.equal(f.store.checkMessagesParity().ok, true);
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test('cancellation does not promote an inline projection to entity authority', t => {
  const f = fixture(t, false); f.store.messageEntityProjection = true;
  f.cancel(); assert.equal(f.raw().messages[0]._entity, undefined);
  assert.ok(f.raw().messages[0].body.startsWith('Question'));
});

test('failed cancellation retains the request, carrier, event head and certificate', t => {
  const f = fixture(t), before = f.raw(), cert = f.certificate(), head = f.store.headSequence('commons');
  f.store.db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT,'cancel fault'); END");
  assert.throws(() => f.cancel('retry-cancel'), /cancel fault/);
  assert.deepEqual(f.raw(), before); assert.deepEqual(f.certificate(), cert);
  assert.equal(f.store.headSequence('commons'), head);
  f.store.db.exec('DROP TRIGGER reject_cancel'); f.cancel('retry-cancel');
  assert.equal(f.raw().replyRequests.ask.status, 'cancelled');
  assert.equal(f.raw().messages[0]._entity, 1);
});

test('cancellation refreshes a valid changed entity and agrees with a cold read', t => {
  const f = fixture(t); f.store.room('commons');
  const certificate = f.certificate();
  f.store.db.exec("UPDATE messages SET body='Changed outside cached projection',record_json=json_set(record_json,'$.body','Changed outside cached projection') WHERE message_id='ask'");
  f.cancel('cancel-refreshed');
  assert.equal(f.raw().replyRequests.ask.status, 'cancelled');
  assert.equal(f.raw().messages[0]._entity, 1);
  const warm = f.store.room('commons').state.messages;
  assert.equal(warm.find(message => message.id === 'ask').body, 'Changed outside cached projection');
  f.store._dropProjectionCache();
  assert.deepEqual(f.store.room('commons').state.messages, warm);
  assert.deepEqual(f.certificate(), certificate);
  assert.equal(f.cancel('cancel-refreshed').duplicate, true);
});

for (const [name, sql] of [
  ['malformed extras', "UPDATE messages SET reducer_extras_json='not-json' WHERE message_id='ask'"],
  ['missing entity', "DELETE FROM messages WHERE message_id='ask'"]
]) test(`warm-cache cancellation refuses ${name} instead of publishing divergent content`, t => {
  const f = fixture(t); f.store.room('commons');
  const head = f.store.headSequence('commons'); f.store.db.exec(sql);
  assert.throws(() => f.cancel(), /projection_corrupt/);
  assert.equal(f.store.headSequence('commons'), head);
  assert.equal(f.raw().replyRequests.ask.status, 'open');
});
