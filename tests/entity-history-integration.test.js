import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

for (const entities of [false, true]) test(`history reactivation and current inbox survive entity cancellation (entities=${entities})`, t => {
  const store = new RoomStore(':memory:', { maintainMessageCertification: true,
    messageProjectionWindow: 100, messageEntityProjection: entities });
  t.after(() => store.close()); store.initialize(initialRoom());
  let now = Date.now() + 10000; store.now = () => now;
  const owner = store.issueAccessKey('commons', 'owner');
  const send = (type, data) => { now += 2001; return store.command(owner, 'commons', { id: crypto.randomUUID(), type, data }); };
  const certify = () => {
    while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture backfill */ }
    assert.equal(store.checkMessagesParity({ roomId: 'commons' }).ok, true);
  };
  send('member.added', { memberId: 'reader', kind: 'agent', displayName: 'Reader', permissions: [] });
  store.dmConsents.request('commons', 'owner', 'reader', 'Fixture');
  store.dmConsents.decide('commons', 'reader', 'owner', 'approve');
  send('room.history_visibility_set', { historyVisibility: 'since_join' }); certify();
  send('message.posted', { messageId: 'old', body: 'Hidden old question', toMemberId: 'reader', requestKind: 'reply' });
  for (const active of [false, true]) {
    const member = store.room('commons').state.members.reader;
    send('member.access_changed', { memberId: 'reader', active, permissions: member.permissions, expectedMemberRevision: member.revision });
  }
  const reader = store.issueAccessKey('commons', 'reader'); certify();
  send('message.posted', { messageId: 'fresh', body: 'Visible question', toMemberId: 'reader', requestKind: 'reply' });
  send('message.posted', { messageId: 'dm', body: 'Original instruction', toMemberId: 'reader' });
  send('message.edited', { messageId: 'dm', expectedMessageRevision: 0, body: 'Corrected instruction' });
  send('message.posted', { messageId: 'deleted', body: 'Deleted instruction', toMemberId: 'reader' });
  send('message.deleted', { messageId: 'deleted', expectedMessageRevision: 0 });
  const raw = () => JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
  if (entities) {
    assert.ok(raw().messages.some(message => message._entity !== 1), 'deleted tombstones remain inline until recertification');
    certify();
    send('message.edited', { messageId: 'dm', expectedMessageRevision: 1, body: 'Corrected instruction' });
    assert.ok(raw().messages.every(message => message._entity === 1), 'exercise recertified references, not the inline fallback');
  }
  const verify = () => {
    assert.throws(() => store.replyRequests.selected(reader, 'commons', 'old'), { code: 'reply_request_not_found' });
    const history = store.replyRequests.history(reader, 'commons');
    assert.deepEqual([...new Set(history.page.items.map(item => item.requestMessageId))], ['fresh']);
    const inbox = store.agentInbox(reader, 'commons', { limit: 1 });
    assert.deepEqual(inbox.directMessages.map(message => [message.messageId, message.body]), [['dm', 'Corrected instruction']]);
    assert.doesNotMatch(JSON.stringify({ history, inbox }), /Hidden old question|Original instruction|Deleted instruction/);
  };
  verify();
  store._dropProjectionCache();
  verify();
  send('reply_request.cancelled', { requestMessageId: 'fresh', expectedRequestRevision: 0, reason: 'Resolved' });
  if (entities) assert.ok(raw().messages.every(message => message._entity === 1), 'cancellation preserves references');
  verify();
  store._dropProjectionCache();
  verify();
});
