import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI, toAuthenticationPublicKey, toAuthenticationResponse } from "../src/auth-signin-ui.js";
import { createPasskeyAuth } from "../server/account-passkeys.mjs";

const encoded = 'AQID';
const credential = { id: 'credential', rawId: Uint8Array.of(1, 2, 3), type: 'public-key', response: {
  clientDataJSON: Uint8Array.of(1, 2, 3), authenticatorData: Uint8Array.of(1, 2, 3),
  signature: Uint8Array.of(1, 2, 3), userHandle: null
} };
function fixture(get, { stale = false } = {}) {
  const listeners = {}, calls = [], signed = [];
  const status = { textContent: '', classList: { toggle() {} } };
  const session = { authenticated: false, sessionRevision: 7 };
  const client = { generation: 2, currentSession: () => session, owns: () => !stale,
    request: async (path, { data }) => {
      calls.push({ path, data });
      if (path.endsWith('/options')) return { challenge: encoded, challengeId: 'challenge', rpId: 'localhost', allowCredentials: [] };
      if (path.endsWith('/finish')) return { authenticated: true, account: { id: 'account' } };
      throw new Error('Unknown route: ' + path);
    } };
  const node = { innerHTML: '', addEventListener: (event, fn) => { listeners[event] = fn; },
    querySelector: selector => selector === '[data-signin-status]' ? status : null,
    querySelectorAll: () => [], setAttribute() {}, contains: () => true };
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {},
    onSignedIn: async session => signed.push(session), credentials: { get } });
  ui.mount(node);
  const click = () => listeners.click({ target: { closest: selector => selector === '[data-passkey-signin]' ? {} : null } });
  return { node, ui, status, calls, signed, click };
}

test('assertion helpers preserve binary signature bytes and a nullable user handle', () => {
  const key = toAuthenticationPublicKey({ challengeId: 'private-ceremony-id', challenge: encoded, allowCredentials: [{ id: encoded, type: 'public-key' }] });
  assert.deepEqual([...key.challenge], [1, 2, 3]);
  assert.deepEqual([...key.allowCredentials[0].id], [1, 2, 3]);
  assert.equal('challengeId' in key, false);
  assert.deepEqual(toAuthenticationResponse(credential), { id: 'credential', rawId: encoded, type: 'public-key',
    response: { clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: null } });
});
test('passkey login uses the current slot and the common signed-in completion', async () => {
  const f = fixture(async ({ publicKey }) => { assert.equal(publicKey.rpId, 'localhost'); return credential; });
  assert.doesNotMatch(f.node.innerHTML, /data-passkey-signin/);
  f.ui.showView("reset-request");
  assert.match(f.node.innerHTML, /data-passkey-signin/);
  await f.click();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].data.sessionRevision, 7);
  assert.equal(f.calls[1].data.challengeId, 'challenge');
  assert.equal(f.signed[0].account.id, 'account');
});
test('cancelling passkey authentication leaves password login usable and sends no assertion', async () => {
  const f = fixture(async () => { throw Object.assign(new Error('user declined'), { name: 'NotAllowedError' }); });
  f.ui.showView('reset-request');
  await f.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.signed.length, 0);
  assert.match(f.status.textContent, /cancelled/);
  assert.equal(f.ui.canLeave(), true);
  f.ui.back();
  assert.match(f.node.innerHTML, /data-signin-form="password"/);
});
test('an assertion obtained after the account view changes cannot upgrade the old slot', async () => {
  const f = fixture(async () => credential, { stale: true });
  f.ui.showView('reset-request');
  await f.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.signed.length, 0);
});
test('signup removes recovery and passkey choices while keeping the return to login', () => {
  const f = fixture(async () => credential); f.ui.showPassword('signup');
  assert.doesNotMatch(f.node.innerHTML, /data-forgot-password|data-email-method|data-passkey-signin|data-signin-back|signin-more/);
  assert.match(f.node.innerHTML, /data-password-mode="login"/);
});
test('registration requires discoverable credentials for account-free passkey login', () => {
  const model = { listPasskeyCredentials: () => [] };
  const service = createPasskeyAuth({ store: { accountLogins: model, now: () => Date.now() } });
  const options = service.beginRegistration({ accountId: 'account', rpId: 'localhost', userName: 'Ada' });
  assert.equal(options.authenticatorSelection.residentKey, 'required');
  assert.equal(options.authenticatorSelection.requireResidentKey, true);
});
