import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { readTelegramBotPage } from '../server/telegram-bot-reader.mjs';
import { auditRecovery } from '../server/recovery.mjs';

test('Telegram observation imports privately, replays safely, supports drafts and recovery', async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember('commons', 'owner'), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const grant = { active: true, accountId: account.id, connectionId: 'telegram-one', revision: 1, authEpoch: 0,
    token: '123456:abcdefghijklmnopqrstuvwxyz', chatIds: [22] };
  const page = await readTelegramBotPage({ authorize: () => grant, fetchImpl: async () => Response.json({ ok: true, result: [
    { update_id: 9, message: { message_id: 7, chat: { id: 22 }, from: { id: 44 }, date: 1700000000, text: 'A private Telegram message' } }
  ] }) });
  const o = page.observations[0];
  const data = { adapter: o.adapter, provider: o.provider, accountId: o.accountId, connectionId: o.connectionId,
    conversationId: o.conversationId, providerMessageId: o.providerMessageId, providerRevision: o.providerRevision,
    sender: o.sender, recipient: 'Project Room bot', subject: 'Telegram conversation', paragraphs: [o.text] };
  const request = { action: 'message.import', requestId: 'telegram-update-9', sourceId: o.sourceId, expectedRevision: 0, data };
  const before = f.store.room('commons').sequence;
  assert.throws(() => f.store.inbox.apply(slot.token, request, session.sessionBinding), { code: 'message_importer_required' });
  assert.throws(() => f.store.inbox.importMessage(slot.token, request, session.sessionBinding), { code: 'message_importer_required' });
  const commit = r => f.store.transaction(() => f.store.inbox.importMessage(slot.token, r, session.sessionBinding));
  assert.equal(commit(request).receipt.revision, 1); assert.equal(commit(request).duplicate, true);
  assert.equal(f.store.room('commons').sequence, before);
  assert.equal(f.store.inbox.list(slot.token, session.sessionBinding).sources[0].adapter, 'message');
  const read = f.store.inbox.read(slot.token, o.sourceId, session.sessionBinding);
  assert.deepEqual(read.source.paragraphs, [o.text]);
  f.store.inbox.apply(slot.token, { action: 'draft.save', requestId: 'draft', sourceId: o.sourceId, sourceRevision: 1, expectedRevision: 0, body: 'Private unsent reply' }, session.sessionBinding);
  commit({ ...request, requestId: 'edit', expectedRevision: 1, data: { ...data, providerRevision: '10', paragraphs: ['Edited private text'] } });
  assert.throws(() => commit({ ...request, requestId: 'stale', expectedRevision: 2 }), { code: 'stale_message_source' });
  assert.equal(f.store.inbox.read(slot.token, o.sourceId, session.sessionBinding).draft.body, 'Private unsent reply');
  const guest = f.store.accountForMember('commons', 'guest'), guestSlot = f.store.createAccountSessionSlot();
  const guestSession = f.store.loginAccountSession(guestSlot.token, f.store.issueAccountAccessKey(guest.id), 0);
  assert.throws(() => f.store.transaction(() => f.store.inbox.importMessage(guestSlot.token, request, guestSession.sessionBinding)), { code: 'message_account_mismatch' });
  assert.equal(f.store.inbox.list(guestSlot.token, guestSession.sessionBinding).sources.length, 0);
  assert.equal(f.store.inbox.verify().versions, 2); assert.ok(auditRecovery(f.store));
});
