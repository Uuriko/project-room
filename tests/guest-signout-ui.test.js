import test from 'node:test';
import assert from 'node:assert/strict';
import { installShareLinks } from '../src/share-links.js';

async function fixture(t) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', textContent: '', hidden: false, disabled: false, open: false, dataset: {}, handlers: {},
      classList: { toggle() {} }, addEventListener(type, handler) { this.handlers[type] = handler; },
      replaceChildren() {}, reset() {}, showModal() { this.open = true; },
      close() { this.open = false; this.handlers.close?.(); },
      focus() { document.activeElement = this; },
      querySelectorAll() { return ['name', 'submit', 'close', 'signout'].map(id => node('#join-link-' + id)); }
    });
    return nodes.get(selector);
  };
  const globals = { document: { querySelector: node, body: {}, activeElement: null },
    window: { addEventListener() {} }, location: { hostname: 'localhost', origin: 'http://localhost:1' } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let restores = 0, logouts = 0;
  const accountClient = {
    session: { authenticated: false, account: null },
    async prepareShareLink() { return { session: this.session, preview: {
      room: { id: 'commons', title: 'Test' }, access: 'chat', link: { expiresAt: Date.now() + 3600000, remainingJoins: 2 }
    } }; },
    async restore() { restores++; return this.session; },
    async logout() { logouts++; return { authenticated: false, account: null }; }
  };
  const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, openRoom() {} });
  await ui.open({ token: 'a'.repeat(43) });
  node('#join-link-signout').hidden = false;
  return { node, ui, accountClient, counts: () => ({ restores, logouts }) };
}

test('guest sign-out locks joins, repeated clicks, closing and replacement invitations until confirmed', async t => {
  const { node, ui, accountClient, counts } = await fixture(t);
  const held = Promise.withResolvers();
  accountClient.restore = () => held.promise;
  const pending = node('#join-link-signout').handlers.click();
  for (const control of node('#join-link-dialog').querySelectorAll()) assert.equal(control.disabled, true);
  await node('#join-link-signout').handlers.click();
  node('#join-link-close').handlers.click();
  assert.equal(node('#join-link-dialog').open, true);
  let prevented = false;
  node('#join-link-dialog').handlers.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await ui.open({ token: 'b'.repeat(43) });
  held.resolve(accountClient.session); await pending;
  assert.equal(counts().logouts, 1);
  assert.match(node('#join-link-status').textContent, /Signed out/);
  assert.equal(node('#join-link-signout').hidden, true);
  assert.equal(document.activeElement, node('#join-link-name'));
  for (const control of node('#join-link-dialog').querySelectorAll()) assert.equal(control.disabled, false);
});

test('externally closed guest sign-out cannot log out a replacement identity after restoration', async t => {
  const { node, accountClient, counts } = await fixture(t);
  const held = Promise.withResolvers();
  accountClient.restore = () => held.promise;
  const pending = node('#join-link-signout').handlers.click();
  node('#join-link-dialog').close();
  accountClient.session = { authenticated: true, account: { id: 'replacement-account' } };
  held.resolve(accountClient.session); await pending;
  assert.equal(counts().logouts, 0);
  assert.equal(document.activeElement, node('#access-key'));
});

for (const operation of ['restore', 'logout']) test(`unconfirmed guest ${operation} never claims sign-out succeeded`, async t => {
  const { node, accountClient, counts } = await fixture(t);
  accountClient[operation] = async () => null;
  await node('#join-link-signout').handlers.click();
  assert.doesNotMatch(node('#join-link-status').textContent, /Signed out/);
  assert.match(node('#join-link-status').textContent, /Try again/);
  assert.equal(counts().logouts, 0);
  assert.equal(node('#join-link-signout').hidden, false);
  assert.equal(document.activeElement, node('#join-link-signout'));
  for (const control of node('#join-link-dialog').querySelectorAll()) assert.equal(control.disabled, false);
});

test('expired guest recovery cannot sign out a newly restored authenticated account', async t => {
  const { node, accountClient, counts } = await fixture(t);
  accountClient.session = null;
  accountClient.restore = async () => ({ authenticated: true, account: { id: 'another-tab-account' } });
  await node('#join-link-signout').handlers.click();
  assert.equal(counts().logouts, 0);
  assert.match(node('#join-link-status').textContent, /Close and review/);
  assert.doesNotMatch(node('#join-link-status').textContent, /Signed out/);
});
