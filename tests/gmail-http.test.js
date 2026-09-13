import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t, configured = true) {
  const f = createAcceptanceFixture(); const calls = [];
  const account = f.store.accountForMember('commons', 'owner'); const slot = f.store.createAccountSessionSlot();
  const auth = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const service = Object.fromEntries(['begin', 'complete', 'sync', 'disconnect'].map(action => [action, (session, value) => {
    calls.push({ action, session, value }); return { state: 'fixture', connectionId: 'gmail-fixture' };
  }]));
  const server = createRoomServer({ store: f.store, gmailConnections: configured ? service : null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: `account_session=${slot.token}`, Origin: origin, 'Content-Type': 'application/json',
    'X-Session-Binding': auth.sessionBinding, 'X-CSRF-Token': auth.csrf };
  return { origin, headers, service, calls, slot, auth, keys: f.keys,
    post: (action, data, h = headers) => fetch(`${origin}/api/inbox/connections/gmail/${action}`, { method: 'POST', headers: h, body: JSON.stringify(data) }) };
}

test('Gmail mutations require account cookie, matching session, CSRF and origin', async t => {
  const f = await setup(t);
  for (const headers of [{ ...f.headers, Cookie: '' }, { ...f.headers, 'X-CSRF-Token': '' },
    { ...f.headers, Origin: 'https://evil.example' }, { ...f.headers, 'X-Session-Binding': '0'.repeat(64) },
    { ...f.headers, Authorization: `Bearer ${f.keys.owner}` }]) {
    const response = await f.post('start', { mailbox: 'pilot@example.com' }, headers);
    assert.ok(response.status >= 400); assert.equal(f.calls.length, 0);
  }
  assert.equal((await f.post('start', { mailbox: 'pilot@example.com' })).status, 200);
  assert.equal(f.calls[0].session.token, f.slot.token);
  assert.equal(f.calls[0].session.binding, f.auth.sessionBinding);
});

test('callback GET works without cookies, contains no reflected code and never exchanges consent', async t => {
  const f = await setup(t);
  const response = await fetch(`${f.origin}/api/inbox/connections/gmail/callback?code=SECRET_CODE&state=state`);
  assert.equal(response.status, 200);
  const html = await response.text(); assert.ok(!html.includes('SECRET_CODE'));
  assert.match(html, /gmail-callback.js/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(f.calls.length, 0);
  const script = await fetch(`${f.origin}/src/gmail-callback.js`);
  assert.equal(script.status, 200); assert.match(await script.text(), /history.replaceState/);
});

test('same-origin completion and sync dispatch only after validation', async t => {
  const f = await setup(t);
  assert.equal((await f.post('complete', { callbackUrl: `${f.origin}/api/inbox/connections/gmail/callback?state=s&code=c` })).status, 200);
  assert.equal((await f.post('sync', { connectionId: 'gmail-fixture' })).status, 200);
  assert.equal((await f.post('disconnect', { connectionId: 'gmail-fixture' })).status, 200);
  assert.deepEqual(f.calls.map(call => call.action), ['complete', 'sync', 'disconnect']);
  assert.equal((await f.post('start', { mailbox: 'pilot@example.com', accountId: 'injected' })).status, 422);
  assert.equal(f.calls.length, 3);
});

test('unconfigured connections fail clearly and provider errors remain private', async t => {
  const disabled = await setup(t, false);
  assert.equal((await disabled.post('start', { mailbox: 'pilot@example.com' })).status, 503);
  const f = await setup(t);
  f.service.complete = () => { throw new Error('SECRET_REFRESH_TOKEN SECRET_CODE'); };
  const response = await f.post('complete', { callbackUrl: f.origin });
  assert.equal(response.status, 409);
  const body = await response.text(); assert.ok(!body.includes('SECRET'));
});
