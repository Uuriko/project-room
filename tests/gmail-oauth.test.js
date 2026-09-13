import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GmailOAuth, GMAIL_READ_SCOPE, GMAIL_CALLBACK_PATH } from '../server/gmail-oauth.mjs';

const redirectUri = `http://127.0.0.1:4173${GMAIL_CALLBACK_PATH}`;
const context = { accountId: 'account-a', sessionBinding: 'binding-a', authEpoch: 1, connectionId: 'gmail-a', revision: 1 };
const mailbox = 'pilot@example.com';
const grant = { access_token: 'access-fixture', refresh_token: 'refresh-fixture', token_type: 'Bearer', expires_in: 3600, scope: GMAIL_READ_SCOPE };
const json = value => new Response(JSON.stringify(value));
function fixture(responder) {
  let now = 100000;
  const calls = [];
  const oauth = new GmailOAuth({ clientId: 'client-fixture', clientSecret: 'secret-fixture', redirectUri,
    now: () => now, fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responder ? responder(url, init, calls.length) : json(calls.length === 1 ? grant : { emailAddress: mailbox });
    } });
  const begin = () => new URL(oauth.begin({ context, mailbox }).authorizationUrl);
  const callback = auth => `${redirectUri}?state=${auth.searchParams.get('state')}&code=code-fixture`;
  return { oauth, calls, begin, callback, advance: ms => { now += ms; } };
}

test('requests read-only consent, pins PKCE, validates mailbox, never fetches messages', async () => {
  const f = fixture();
  const auth = f.begin();
  assert.equal(auth.origin, 'https://accounts.google.com');
  assert.equal(auth.searchParams.get('scope'), GMAIL_READ_SCOPE);
  assert.equal(auth.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!auth.href.includes('secret-fixture'));
  const result = await f.oauth.complete({ callbackUrl: f.callback(auth), getContext: () => context });
  assert.equal(result.mailbox, mailbox);
  assert.equal(result.refreshToken, 'refresh-fixture');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(f.calls[0].init.body);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(f.calls[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  assert.ok(f.calls.every(call => call.init.redirect === 'error' && call.init.signal));
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(auth), getContext: () => context }), { code: 'gmail_state_invalid' });
});

for (const field of ['accountId', 'sessionBinding', 'authEpoch', 'connectionId', 'revision']) {
  test(`rejects changed ${field} before exchanging code`, async () => {
    const f = fixture(); const auth = f.begin();
    const changed = { ...context, [field]: typeof context[field] === 'number' ? 2 : 'other' };
    await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(auth), getContext: () => changed }), { code: 'gmail_session_changed' });
    assert.equal(f.calls.length, 0);
  });
}

test('state expiry and superseded attempts fail without network', async () => {
  const f = fixture(); const old = f.begin(); const current = f.begin();
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(old), getContext: () => context }), { code: 'gmail_state_invalid' });
  f.advance(600000);
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(current), getContext: () => context }), { code: 'gmail_state_invalid' });
  assert.equal(f.calls.length, 0);
});

test('rejects malformed, duplicate and cross-origin callbacks', async () => {
  const f = fixture(); const auth = f.begin();
  for (const url of [f.callback(auth).replace('127.0.0.1', 'evil.example'), `${f.callback(auth)}&state=x`, `${f.callback(auth)}&code=x`, `${f.callback(auth)}#fragment`])
    await assert.rejects(f.oauth.complete({ callbackUrl: url, getContext: () => context }), { code: 'gmail_callback_invalid' });
  assert.equal(f.calls.length, 0);
});

test('denied consent consumes state and never exchanges tokens', async () => {
  const f = fixture(); const auth = f.begin();
  await assert.rejects(f.oauth.complete({ callbackUrl: `${f.callback(auth)}&error=access_denied`, getContext: () => context }), { code: 'gmail_consent_denied' });
  assert.equal(f.calls.length, 0);
});

test('rejects expanded scopes and missing refresh credentials before profile read', async () => {
  for (const [token, code] of [[{ ...grant, scope: `${GMAIL_READ_SCOPE} https://mail.google.com/` }, 'gmail_scope_mismatch'], [{ ...grant, refresh_token: undefined }, 'gmail_token_invalid']]) {
    const f = fixture(() => json(token)); const auth = f.begin();
    await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(auth), getContext: () => context }), { code });
    assert.equal(f.calls.length, 1);
  }
});

test('wrong mailbox is not connected', async () => {
  const f = fixture((url, init, n) => json(n === 1 ? grant : { emailAddress: 'other@example.com' }));
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(f.begin()), getContext: () => context }), { code: 'gmail_mailbox_mismatch' });
});

test('session invalidated during exchange prevents profile request', async () => {
  const f = fixture(); let checks = 0;
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(f.begin()), getContext: () => ++checks === 1 ? context : { ...context, authEpoch: 2 } }), { code: 'gmail_session_changed' });
  assert.equal(f.calls.length, 1);
});

test('provider errors and oversized responses do not expose secrets', async () => {
  for (const response of [() => { throw new Error('access-fixture secret-fixture'); }, () => new Response('secret-fixture', { status: 400 }), () => new Response('x'.repeat(65537))]) {
    const f = fixture(response);
    await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(f.begin()), getContext: () => context }), error => {
      assert.ok(!error.message.includes('fixture')); return true;
    });
  }
});

test('parallel replay exchanges only once', async () => {
  const f = fixture(); const callbackUrl = f.callback(f.begin());
  const outcomes = await Promise.allSettled([1, 2].map(() => f.oauth.complete({ callbackUrl, getContext: () => context })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.calls.length, 2);
});

test('requires HTTPS except exact loopback and fixed callback path', () => {
  for (const uri of ['http://example.com', 'http://localhost:4173', 'https://example.com/wrong', `${redirectUri}?x=1`])
    assert.throws(() => new GmailOAuth({ clientId: 'client', clientSecret: 'secret', redirectUri: uri }), { code: 'gmail_configuration_invalid' });
});

test('starting a replacement attempt during exchange invalidates the old attempt', async () => {
  let f;
  f = fixture(() => { f.begin(); return json(grant); });
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(f.begin()), getContext: () => context }), { code: 'gmail_state_invalid' });
  assert.equal(f.calls.length, 1);
});

test('authority changing during profile read prevents returning credentials', async () => {
  const f = fixture(); let checks = 0;
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(f.begin()), getContext: () => ++checks < 3 ? context : { ...context, revision: 2 } }), { code: 'gmail_session_changed' });
  assert.equal(f.calls.length, 2);
});

test('refresh retains original narrow scope and refresh token when Google omits them', async () => {
  const f = fixture(() => json({ access_token: 'renewed-token', token_type: 'Bearer', expires_in: 3600 }));
  const result = await f.oauth.refresh({ refreshToken: 'old-refresh', scope: GMAIL_READ_SCOPE });
  assert.equal(result.refreshToken, 'old-refresh'); assert.equal(result.scope, GMAIL_READ_SCOPE);
  assert.equal(new URLSearchParams(f.calls[0].init.body).get('grant_type'), 'refresh_token');
  assert.equal(f.calls[0].init.redirect, 'error');
});

test('refresh accepts rotation but rejects broadened or malformed grants', async () => {
  const f = fixture(() => json({ ...grant, refresh_token: 'rotated-refresh' }));
  assert.equal((await f.oauth.refresh({ refreshToken: 'old', scope: GMAIL_READ_SCOPE })).refreshToken, 'rotated-refresh');
  for (const value of [{ ...grant, scope: 'https://mail.google.com/' }, { ...grant, expires_in: -1 }, { ...grant, refresh_token: '' }]) {
    const bad = fixture(() => json(value));
    await assert.rejects(bad.oauth.refresh({ refreshToken: 'old', scope: GMAIL_READ_SCOPE }));
  }
});
