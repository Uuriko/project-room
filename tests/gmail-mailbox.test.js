import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { gmailContractFixture } from '../scripts/gmail-contract-fixture.mjs';
import { GmailMailbox, gmailConfig } from '../server/gmail-mailbox.mjs';
import { createRoomServer } from '../server/http.mjs';
const scope = 'https://www.googleapis.com/auth/gmail.modify';
function setup(t, options = {}) {
  const f = createAcceptanceFixture(), store = f.store;
  t.after(() => { store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const account = store.accountForMember('commons', 'owner'), key = store.issueAccountAccessKey(account.id);
  const slot = store.createAccountSessionSlot(), session = store.loginAccountSession(slot.token, key, 0);
  const calls = [], message = gmailContractFixture().messages[0].response.message;
  const config = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', tokenKey: '42'.repeat(32), redirectUri: 'https://room.example/api/auth/gmail/callback',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      if (url.includes('/token')) return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: options.scope ?? scope });
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'morgan@gmail.test' });
      if (url.includes('/messages?')) return Response.json({ messages: [{ id: message.id }] });
      return Response.json(message);
    } };
  const gmail = new GmailMailbox(store, config);
  const auth = () => gmail.auth(slot.token, session.sessionBinding);
  const begin = () => new URL(gmail.begin(slot.token, session.sessionBinding));
  const callback = url => new URL(config.redirectUri + '?state=' + url.searchParams.get('state') + '&code=fixture-code');
  const complete = url => gmail.complete(url, url.searchParams.get('state'));
  return { ...f, account, slot, session, gmail, auth, begin, callback, complete, calls, config };
}
test('Gmail connect uses Gmail modify consent and PKCE, survives a new service, encrypts credentials, imports idempotently, disconnects', async t => {
  const f = setup(t), url = f.begin();
  assert.equal(url.searchParams.get('scope'), scope); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const pending = f.store.db.prepare('SELECT encrypted FROM gmail_pending').get().encrypted;
  assert.ok(!pending.includes(f.slot.token));
  await new GmailMailbox(f.store, f.config).complete(f.callback(url), url.searchParams.get('state'));
  assert.equal(f.gmail.status(f.auth()).state, 'connected');
  const stored = f.store.db.prepare('SELECT encrypted FROM gmail_mailboxes').get().encrypted;
  assert.ok(!stored.includes('fixture-refresh'));
  assert.equal(await f.gmail.sync(f.slot.token, f.session.sessionBinding), 1);
  assert.equal(await f.gmail.sync(f.slot.token, f.session.sessionBinding), 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM private_inbox_sources WHERE account_id=?').get(f.account.id).n, 1);
  await assert.rejects(() => f.complete(f.callback(url)), { code: 'gmail_expired' });
  f.gmail.disconnect(f.slot.token, f.session.sessionBinding);
  assert.equal(f.gmail.status(f.auth()).state, 'disconnected');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM gmail_mailboxes').get().n, 0);
  await assert.rejects(() => f.gmail.sync(f.slot.token, f.session.sessionBinding), { code: 'gmail_reconnect_required' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM private_inbox_sources').get().n, 1);
});
test('denied or missing scopes never creates a connection', async t => {
  const f = setup(t, { scope: 'openid email profile' });
  const denied = f.callback(f.begin()); denied.searchParams.set('error', 'access_denied');
  await assert.rejects(() => f.complete(denied), { code: 'gmail_consent_denied' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => f.complete(f.callback(f.begin())), { code: 'gmail_permissions_required' });
  assert.equal(f.gmail.status(f.auth()).state, 'disconnected');
});
test('account switch invalidates consent before provider access', async t => {
  const f = setup(t), callback = f.callback(f.begin());
  const other = f.store.createAccount('other-gmail-owner');
  f.store.loginAccountSession(f.slot.token, f.store.issueAccountAccessKey(other.id), f.session.sessionRevision);
  await assert.rejects(() => f.complete(callback)); assert.equal(f.calls.length, 0);
});
test('disconnect during an OAuth exchange prevents the callback from restoring access', async t => {
  const f = setup(t); const original = f.config.fetchImpl;
  f.config.fetchImpl = async (...args) => { if (args[0].includes('/token')) f.gmail.disconnect(f.slot.token, f.session.sessionBinding); return original(...args); };
  await assert.rejects(() => f.complete(f.callback(f.begin())), { code: 'gmail_session_changed' });
  assert.equal(f.gmail.status(f.auth()).state, 'disconnected');
});
test('tampered ciphertext is rejected and explicit enablement requires encryption key', async t => {
  const f = setup(t); await f.complete(f.callback(f.begin()));
  f.store.db.prepare("UPDATE gmail_mailboxes SET encrypted='bad'").run();
  assert.throws(() => f.gmail.status(f.auth()), { code: 'gmail_reconnect_required' });
  assert.equal(gmailConfig({}, 'https://room.example'), null);
  assert.throws(() => gmailConfig({ ROOM_GMAIL_ENABLED: '1' }, 'https://room.example'));
});
test('HTTP enforces CSRF and ownership, persists setup and reports disabled Gmail honestly', async t => {
  const f = setup(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const headers = { Cookie: 'account_session=' + f.slot.token, 'X-Session-Binding': f.session.sessionBinding, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': f.session.csrf };
  const get = path => fetch(origin + path, { headers });
  const status = await get('/api/inbox/gmail'); assert.equal(status.status, 200, await status.clone().text());
  assert.equal((await status.json()).state, 'unavailable');
  const data = { name: 'Morgan', purpose: 'team', platforms: ['Gmail', 'Slack'], step: 1, completed: false };
  const request = csrf => fetch(origin + '/api/inbox/setup', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': csrf }, body: JSON.stringify(data) });
  assert.equal((await request('bad')).status, 403);
  assert.equal((await request(f.session.csrf)).status, 200);
  assert.deepEqual((await (await get('/api/inbox/setup')).json()).setup, data);
  assert.equal((await fetch(origin + '/api/inbox/gmail')).status, 422);
});

test('account deletion removes grants, pending connections and setup answers', async t => {
  const { planAccountDeletion, executeAccountDeletion } = await import('../server/account-deletion.mjs');
  const f = setup(t); await f.complete(f.callback(f.begin())); f.begin();
  f.store.db.prepare('INSERT INTO account_setup VALUES(?,?)').run(f.account.id, '{}');
  f.store.db.prepare('INSERT INTO gmail_operations VALUES(?,?,?,?,?)').run(f.account.id, 'deletion-test', 'f'.repeat(64), '{"state":"unknown"}', 0);
  executeAccountDeletion(f.store, planAccountDeletion(f.store, f.account.id).plan);
  for (const table of ['gmail_mailboxes', 'gmail_pending', 'gmail_operations', 'account_setup']) assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
});
test('revoked refresh grant offers reconnect instead of an endless sync retry', async t => {
  const f = setup(t); await f.complete(f.callback(f.begin()));
  f.config.fetchImpl = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await assert.rejects(() => f.gmail.sync(f.slot.token, f.session.sessionBinding), { code: 'gmail_reconnect_required' });
  assert.equal(f.gmail.status(f.auth()).state, 'reconnect_required');
});

test('forwarded authorization links cannot attach someone else’s Gmail mailbox', async t => {
  const f = setup(t), callback = f.callback(f.begin());
  await assert.rejects(() => f.gmail.complete(callback), { code: 'gmail_browser_changed' });
  await assert.rejects(() => f.gmail.complete(callback, 'a'.repeat(43)), { code: 'gmail_browser_changed' });
  assert.equal(f.calls.length, 0);
  await f.complete(callback); // Failed browser checks did not consume the genuine flow.
  assert.equal(f.gmail.status(f.auth()).state, 'connected');
});

test('mailbox credentials stay account-scoped and expired consent never calls Google', async t => {
  const f = setup(t); await f.complete(f.callback(f.begin()));
  const other = f.store.createAccount('gmail-isolation-other');
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(other.id), 0);
  assert.equal(f.gmail.status(f.gmail.auth(slot.token, session.sessionBinding)).state, 'disconnected');
  await assert.rejects(() => f.gmail.sync(slot.token, session.sessionBinding), { code: 'gmail_reconnect_required' });
  const callback = f.callback(f.begin()), before = f.calls.length;
  const originalNow = f.store.now; f.store.now = () => originalNow() + 600001;
  await assert.rejects(() => f.complete(callback), { code: 'gmail_expired' });
  assert.equal(f.calls.length, before);
});

test('operator-only Gmail pilot does not expose OAuth or background grants to other accounts', async t => {
  const f = setup(t); await f.complete(f.callback(f.begin()));
  const restricted = new GmailMailbox(f.store, { ...f.config, allowedAccountIds: ['different-account'] });
  assert.equal(restricted.status(f.auth()).state, 'unavailable');
  assert.deepEqual(restricted.records(f.auth()), []);
  assert.throws(() => restricted.begin(f.slot.token, f.session.sessionBinding), { code: 'gmail_not_configured' });
  const allowed = new GmailMailbox(f.store, { ...f.config, allowedAccountIds: [f.account.id] });
  assert.equal(allowed.status(f.auth()).state, 'connected');
});
