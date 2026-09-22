import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { gmailLiveFixture } from '../scripts/gmail-live-fixture.mjs';
import { GmailMailbox } from '../server/gmail-mailbox.mjs';
import { GmailActions } from '../server/gmail-actions.mjs';
import { GmailSync } from '../server/gmail-sync.mjs';
import { gmailImportToken, gmailImportAuth } from '../server/gmail-import-authority.mjs';
async function setup(t) {
  const f = createAcceptanceFixture(), provider = gmailLiveFixture(), m = new GmailMailbox(f.store, provider.config);
  t.after(() => { f.store.close(); rmSync(f.directory, { force: true, recursive: true }); });
  const account = f.store.accountForMember('commons', 'owner'), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const connect = async options => { const url = new URL(m.begin(slot.token, session.sessionBinding, options)); url.host = 'room.example'; url.pathname = '/api/auth/gmail/callback'; url.searchParams.set('code', 'test'); return m.complete(url, url.searchParams.get('state')); };
  await connect();
  const id = m.record(m.auth(slot.token, session.sessionBinding)).connectionId;
  return { ...f, ...provider, m, account, slot, session, id, connect, sync: new GmailSync(m), actions: new GmailActions(m) };
}
test('background history sync imports without session and propagates read/archive/delete changes', async t => {
  const f = await setup(t), before = f.store.inbox.list(f.slot.token, f.session.sessionBinding, { includeChannels: true }).sources.length;
  assert.equal((await f.sync.mailboxTick(f.account.id, f.id)).imported, 1);
  const list = () => f.store.inbox.list(f.slot.token, f.session.sessionBinding, { includeChannels: true }).sources;
  const mail = list().find(s => s.connection?.id === f.id); assert.ok(mail); assert.equal(list().length, before + 1); assert.equal(mail.readAt, null);
  const count = f.store.db.prepare('SELECT count(*) n FROM private_email_commands').get().n;
  assert.equal((await f.sync.mailboxTick(f.account.id, f.id)).imported, 0); assert.equal(f.store.db.prepare('SELECT count(*) n FROM private_email_commands').get().n, count);
  f.messages.get('mail-1').labelIds = ['INBOX']; f.changed(f.messages.get('mail-1')); await f.sync.mailboxTick(f.account.id, f.id); assert.ok(list().find(s => s.id === mail.id).readAt);
  f.messages.get('mail-1').labelIds = []; f.changed(f.messages.get('mail-1')); await f.sync.mailboxTick(f.account.id, f.id); assert.ok(!list().some(s => s.id === mail.id));
  f.messages.get('mail-1').labelIds = ['INBOX']; f.changed(f.messages.get('mail-1')); await f.sync.mailboxTick(f.account.id, f.id); assert.ok(list().some(s => s.id === mail.id));
  f.changed(f.messages.get('mail-1')); f.messages.delete('mail-1'); await f.sync.mailboxTick(f.account.id, f.id); assert.ok(!list().some(s => s.id === mail.id));
  assert.doesNotThrow(() => f.store.connections.verify()); assert.doesNotThrow(() => f.store.inbox.verify());
});
test('expired Gmail history rescans; revoked grants back off; disconnect during sync cannot reimport', async t => {
  const f = await setup(t); await f.sync.mailboxTick(f.account.id, f.id); const original = f.config.fetchImpl;
  f.config.fetchImpl = (url, init) => url.includes('/history?') ? Promise.resolve(Response.json({}, { status: 404 })) : original(url, init);
  assert.equal((await f.sync.mailboxTick(f.account.id, f.id)).imported, 1);
  f.config.fetchImpl = async (url, init) => { const r = await original(url, init); if (url.includes('/token')) f.m.disconnect(f.slot.token, f.session.sessionBinding, f.id); return r; };
  await assert.rejects(f.sync.mailboxTick(f.account.id, f.id), { code: 'gmail_session_changed' });
  f.config.fetchImpl = original; await f.connect(); f.config.fetchImpl = async () => Response.json({}, { status: 401 });
  await f.sync.tick(); assert.equal(f.m.status(f.m.auth(f.slot.token, f.session.sessionBinding)).state, 'reconnect_required');
});
test('multiple mailboxes retain separate encrypted grants, sender identities and disconnects', async t => {
  const f = await setup(t), firstFetch = f.config.fetchImpl, second = gmailLiveFixture('second@gmail.test');
  f.config.fetchImpl = second.config.fetchImpl; const added = await f.connect({ add: true });
  f.config.fetchImpl = (url, init) => (url.includes('/token') ? new URLSearchParams(init.body).get('refresh_token')?.includes('second@') : init.headers.Authorization?.includes('second@')) ? second.config.fetchImpl(url, init) : firstFetch(url, init);
  const status = f.m.status(f.m.auth(f.slot.token, f.session.sessionBinding)); assert.equal(status.mailboxes.length, 2); assert.notEqual(status.mailboxes[0].id, status.mailboxes[1].id);
  const send = await f.actions.run(f.slot.token, f.session.sessionBinding, { action: 'send', mailboxId: added.mailboxId, requestId: 'second-send', to: 'recipient@example.com', subject: 'Second sender', body: 'Account two' }); assert.equal(send.state, 'accepted');
  const request = second.calls.find(c => c.url.endsWith('/messages/send')); assert.ok(request); assert.match(Buffer.from(JSON.parse(request.body).raw, 'base64url').toString(), /From: second@gmail.test/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/messages/send')).length, 0);
  f.m.disconnect(f.slot.token, f.session.sessionBinding, f.id); assert.equal(f.m.status(f.m.auth(f.slot.token, f.session.sessionBinding)).mailboxes.length, 1);
  assert.equal((await f.sync.mailboxTick(f.account.id, added.mailboxId)).imported, 1);
});
test('background import capability is unforgeable, account-bound, import-only and epoch-fenced', async t => {
  const f = await setup(t); assert.equal(gmailImportAuth(f.store, { accountId: f.account.id }, { action: 'page.apply' }), null);
  const token = gmailImportToken(f.store, f.account.id, f.id, () => {});
  assert.throws(() => gmailImportAuth(f.store, token, { action: 'send', connectionId: f.id }), { code: 'gmail_import_authority' });
  assert.throws(() => gmailImportAuth(f.store, token, { action: 'page.apply', connectionId: 'other' }), { code: 'gmail_import_authority' });
  f.m.disconnect(f.slot.token, f.session.sessionBinding, f.id);
  assert.throws(() => gmailImportAuth(f.store, token, { action: 'page.apply', connectionId: f.id }), { code: 'gmail_import_authority' });
});
