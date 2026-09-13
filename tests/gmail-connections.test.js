import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { GmailOAuth, GMAIL_READ_SCOPE, GMAIL_CALLBACK_PATH } from '../server/gmail-oauth.mjs';
import { MailCredentialVault } from '../server/mail-credential-vault.mjs';
import { GmailConnections } from '../server/gmail-connections.mjs';

function fixture(t) {
  const f = createAcceptanceFixture();
  const db = new DatabaseSync(':memory:');
  const vault = new MailCredentialVault({ db, key: randomBytes(32) });
  t.after(() => { vault.close(); db.close(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = f.store.accountForMember('commons', 'owner');
  const slot = f.store.createAccountSessionSlot();
  const auth = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const session = { token: slot.token, binding: auth.sessionBinding };
  const mailbox = 'pilot@example.com'; const calls = [];
  let hook = () => {};
  const fetchImpl = async (url, init) => {
    calls.push(url); hook(url, init);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'access-fixture', refresh_token: 'refresh-fixture',
      token_type: 'Bearer', expires_in: 3600, scope: GMAIL_READ_SCOPE });
    if (url.endsWith('/profile')) return Response.json({ emailAddress: mailbox });
    if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'abc123' }] });
    return Response.json({ id: 'abc123', threadId: 'abc123', historyId: '1', internalDate: '1789214400000', labelIds: ['INBOX'],
      raw: Buffer.from('From: sender@example.com\r\nContent-Type: text/plain\r\n\r\nPrivate live-shaped note').toString('base64url') });
  };
  const redirect = `http://127.0.0.1:4173${GMAIL_CALLBACK_PATH}`;
  const oauth = new GmailOAuth({ clientId: 'client', clientSecret: 'secret', redirectUri: redirect, fetchImpl, now: () => f.store.now() });
  const service = new GmailConnections({ store: f.store, vault, oauth, fetchImpl });
  const begin = () => service.begin(session, mailbox);
  const callback = pending => `${redirect}?state=${new URL(pending.authorizationUrl).searchParams.get('state')}&code=fixture-code`;
  const expire = id => {
    const profile = f.store.email.connection(account.id, id).profile;
    const binding = { accountId: account.id, connectionId: id, authEpoch: account.authEpoch,
      connectionRevision: profile.revision, provider: 'gmail', mailbox };
    const previous = vault.read(binding);
    vault.put({ binding, expectedVersion: previous.version, credentials: { ...previous.credentials, expiresAt: f.store.now() - 1 } });
  };
  return { ...f, db, account, session, service, begin, callback, calls, expire, hook: value => { hook = value; } };
}

test('OAuth to encrypted credentials to private Inbox, followed by disconnect', async t => {
  const f = fixture(t); const pending = f.begin();
  const before = JSON.stringify(f.store.room('commons').state.messages);
  const connected = await f.service.complete(f.session, f.callback(pending));
  assert.equal(connected.state, 'connected');
  assert.equal(f.service.list(f.session)[0].state, 'connected');
  assert.ok(!JSON.stringify(connected).includes('fixture'));
  const row = f.db.prepare('SELECT * FROM mail_credentials_v1').get();
  assert.ok(!Buffer.from(row.ciphertext).toString().includes('refresh-fixture'));
  const synced = await f.service.sync(f.session, pending.connectionId);
  assert.equal(synced.imported, 1); assert.equal(synced.complete, true);
  const source = f.store.db.prepare('SELECT id FROM private_inbox_sources WHERE account_id=?').get(f.account.id);
  const view = f.store.inbox.read(f.session.token, source.id, f.session.binding, { emailView: true, excerptView: true });
  assert.match(view.source.paragraphs[0], /Private live-shaped note/);
  assert.equal(JSON.stringify(f.store.room('commons').state.messages), before);
  assert.equal((await f.service.disconnect(f.session, pending.connectionId)).providerRevoked, true);
  assert.equal(f.service.list(f.session)[0].state, 'disconnected');
  await assert.rejects(f.service.sync(f.session, pending.connectionId), { code: 'gmail_reconnect_required' });
  assert.equal(f.db.prepare('SELECT ciphertext FROM mail_credentials_v1').get().ciphertext, null);
});

test('changed session cannot complete consent or store credentials', async t => {
  const f = fixture(t); const pending = f.begin();
  await assert.rejects(f.service.complete({ ...f.session, binding: 'wrong' }, f.callback(pending)));
  assert.equal(f.db.prepare('SELECT count(*) n FROM mail_credentials_v1').get().n, 0);
  assert.equal(f.calls.length, 0);
});

test('disconnect during fetch prevents importing the returned page', async t => {
  const f = fixture(t); const pending = f.begin(); await f.service.complete(f.session, f.callback(pending));
  f.hook(url => { if (url.includes('/messages/')) f.service.disconnect(f.session, pending.connectionId); });
  await assert.rejects(f.service.sync(f.session, pending.connectionId), { code: 'gmail_read_authorization_required' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM private_inbox_sources WHERE account_id=?').get(f.account.id).n, 0);
});

test('reconnect uses a new revision and never revives an old callback', async t => {
  const f = fixture(t); const first = f.begin(); await f.service.complete(f.session, f.callback(first));
  await f.service.disconnect(f.session, first.connectionId);
  const second = f.begin(); await f.service.complete(f.session, f.callback(second));
  assert.equal(f.store.email.connection(f.account.id, first.connectionId).profile.revision, 3);
  await assert.rejects(f.service.complete(f.session, f.callback(first)), { code: 'gmail_state_invalid' });
  assert.equal((await f.service.sync(f.session, first.connectionId)).imported, 1);
});

test('concurrent scans cannot overwrite the same page checkpoint', async t => {
  const f = fixture(t); const pending = f.begin(); await f.service.complete(f.session, f.callback(pending));
  const results = await Promise.allSettled([f.service.sync(f.session, pending.connectionId), f.service.sync(f.session, pending.connectionId)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'stale_email_page');
});

test('expired credentials renew once for concurrent syncs and remain encrypted', async t => {
  const f = fixture(t); const pending = f.begin(); await f.service.complete(f.session, f.callback(pending)); f.expire(pending.connectionId);
  let refreshes = 0;
  f.hook((url, init) => { if (url === 'https://oauth2.googleapis.com/token' && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') refreshes++; });
  const results = await Promise.allSettled([f.service.sync(f.session, pending.connectionId), f.service.sync(f.session, pending.connectionId)]);
  assert.equal(refreshes, 1);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(f.db.prepare('SELECT version FROM mail_credentials_v1').get().version, 3);
});

test('disconnect during token renewal cannot restore credentials or read mail', async t => {
  const f = fixture(t); const pending = f.begin(); await f.service.complete(f.session, f.callback(pending)); f.expire(pending.connectionId);
  f.hook(url => { if (url === 'https://oauth2.googleapis.com/token') f.service.disconnect(f.session, pending.connectionId); });
  const before = f.calls.length;
  await assert.rejects(f.service.sync(f.session, pending.connectionId), { code: 'gmail_read_authorization_required' });
  assert.equal(f.calls.length, before + 2); // refresh plus revoke; no mailbox request
  const row = f.db.prepare('SELECT state,ciphertext FROM mail_credentials_v1').get();
  assert.equal(row.state, 'disconnected'); assert.equal(row.ciphertext, null);
});

test('failed Google revocation still removes local credentials and reports uncertainty', async t => {
  const f = fixture(t); const pending = f.begin(); await f.service.complete(f.session, f.callback(pending));
  f.hook(url => { if (url.endsWith('/revoke')) throw new Error('private-provider-error'); });
  const result = await f.service.disconnect(f.session, pending.connectionId);
  assert.deepEqual(result, { connectionId: pending.connectionId, state: 'disconnected', providerRevoked: false });
  assert.equal(f.db.prepare('SELECT ciphertext FROM mail_credentials_v1').get().ciphertext, null);
  await assert.rejects(f.service.sync(f.session, pending.connectionId), { code: 'gmail_reconnect_required' });
});
