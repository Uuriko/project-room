import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { buildReplyCommand } from '../client/reply-actions.mjs';

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.dmConsents.request('commons', 'owner', 'producer', 'fixture');
  f.store.dmConsents.decide('commons', 'producer', 'owner', 'approve');
  f.store.command(f.keys.owner, 'commons', { id: 'private-question', type: 'message.posted', data: {
    messageId: 'private-question', requestKind: 'reply', toMemberId: 'producer', body: 'Private question'
  } });
  const reply = (member, id, replyToId) => f.store.command(f.keys[member], 'commons',
    buildReplyCommand({ roomId: 'commons', memberId: member }, 'room_reply', { requestId: id, replyToId, body: 'Context' }));
  return { ...f, reply };
}

test('room_reply rejects a nonparticipant private request reference without changing context or public messages', t => {
  const f = fixture(t), before = f.store.room('commons');
  assert.throws(() => f.store.replyRequests.selected(f.keys.reviewer, 'commons', 'private-question'), { status: 404 });
  assert.throws(() => f.reply('reviewer', 'injected-context', 'private-question'), { code: 'command_rejected' });
  const after = f.store.room('commons');
  assert.equal(after.sequence, before.sequence);
  assert.deepEqual(after.state.replyRequests, before.state.replyRequests);
  assert.deepEqual(after.state.messages, before.state.messages);
});

test('public threads and both private request participants can add context; outsiders cannot use a public descendant', t => {
  const f = fixture(t);
  const owner = f.reply('owner', 'owner-context', 'private-question');
  f.reply('producer', 'recipient-context', 'private-question');
  assert.throws(() => f.reply('reviewer', 'indirect-injection', owner.event.data.messageId), { code: 'command_rejected' });
  f.store.command(f.keys.owner, 'commons', { id: 'public', type: 'message.posted', data: { messageId: 'public', body: 'Public question' } });
  assert.ok(f.reply('reviewer', 'public-reply', 'public').event);
});

test('room ownership does not grant private reply-context injection authority', t => {
  const f = fixture(t);
  f.store.command(f.keys.guest, 'commons', { id: 'guest-question', type: 'message.posted', data: {
    messageId: 'guest-question', requestKind: 'reply', toMemberId: 'producer', body: 'Another private question'
  } });
  assert.throws(() => f.reply('owner', 'owner-injection', 'guest-question'), { code: 'command_rejected' });
});
