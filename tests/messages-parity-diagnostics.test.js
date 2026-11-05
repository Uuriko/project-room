import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

function fixture(t, copy = false) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  let now = Date.now() + 10000; store.now = () => now;
  for (const id of ['target', 'later']) {
    now += 2001;
    store.command(owner, 'commons', { id, type: 'message.posted', data: { messageId: id, body: 'Private original phrase ' + id,
      ...(copy && id === 'later' ? { replyToId: 'target', alsoSendToChannel: true } : {}) } });
  }
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  assert.equal(store.checkMessagesParity({ roomId: 'commons' }).ok, true);
  return store;
}

for (const [field, value] of [
  ['body', 'Private corrupt phrase'], ['author_id', 'private-author'],
  ['channel_id', 'private-channel'], ['thread_root_id', 'private-root'],
  ['reply_to_id', 'private-parent'], ['to_member_id', 'private-recipient'],
  ['work_item_id', 'private-work'], ['created_at', 'private-time'],
  ['edited_at', 'private-time'], ['deleted_at', 'private-time'], ['pinned', 1],
  ['seq', 1], ['record_json', '{private-invalid-json'],
  ['reducer_extras_json', '{private-invalid-json']
]) test(`parity identifies ${field} without copying its value`, t => {
  const store = fixture(t);
  store.db.prepare(`UPDATE messages SET ${field}=? WHERE room_id='commons' AND message_id='target'`).run(value);
  assert.throws(() => store.checkMessagesParity({ roomId: 'commons' }), error => {
    assert.equal(error.message, `messages parity failed for commons: current record target differs (${field})`);
    assert.doesNotMatch(error.message, /Private|private-/);
    return true;
  });
  assert.equal(store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id='commons'").get().parity_at_seq, null);
});

test('diagnostic distinguishes simultaneous content and index drift and survives operator recording', t => {
  const store = fixture(t);
  store.db.exec("UPDATE messages SET body='secret replacement',to_member_id='secret recipient',record_json=json_set(record_json,'$.body','secret replacement') WHERE message_id='target'");
  store.runIntegrityParityStep();
  const failure = store.integrityFailures().find(row => row.step === 'messages_parity' && row.recordId === 'commons');
  assert.ok(failure);
  assert.match(failure.message, /differs \(record_json, body, to_member_id\)/);
  assert.doesNotMatch(failure.message, /secret|Private/);
});

test('legacy null reducer extras retain their existing parity contract', t => {
  const store = fixture(t);
  store.db.exec("UPDATE messages SET reducer_extras_json=NULL WHERE message_id='target'");
  assert.equal(store.checkMessagesParity({ roomId: 'commons' }).ok, true);
});

test('operator diagnostic rejects unrecognized field labels and appended content', t => {
  const store = fixture(t);
  for (const suffix of ['(body, private_secret)', '(body) Private original phrase', '(body, body=secret)']) {
    store.recordIntegrityFailure('messages_parity', 'commons', new Error(`messages parity failed for commons: current record target differs ${suffix}`));
    const failure = store.integrityFailures().find(row => row.step === 'messages_parity');
    assert.equal(failure.message, 'messages parity failed: stored messages disagree with the projection');
  }
});

test('real channel-copy row retains field diagnostics in operator records', t => {
  const store = fixture(t, true);
  store.db.exec("UPDATE messages SET body='private-copy-drift' WHERE message_id='later:channel'");
  store.runIntegrityParityStep();
  const failure = store.integrityFailures().find(row => row.step === 'messages_parity');
  assert.equal(failure.message, 'messages parity failed for commons: current record later:channel differs (body)');
});
