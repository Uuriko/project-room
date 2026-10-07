// Primary browser-platform lifecycle owner: server push tests cannot control
// a permission/registration promise resolving after sign-out. No DOM renderer
// or production-only seam is needed; exercise installed user event handlers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installHumanPush } from '../src/human-push.js';

function control() {
  const handlers = new Map();
  return { hidden: false, disabled: false, checked: true, textContent: '',
    addEventListener(name, handler) { assert.ok(['click', 'change'].includes(name)); handlers.set(name, handler); },
    fire(name) { assert.ok(handlers.has(name)); return handlers.get(name)(); } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup(t, { permission = 'default', requestPermission = async () => 'granted', subscription = null, register = null } = {}) {
  const descriptors = new Map(['navigator', 'Notification'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = [], saved = [], preferences = [];
  const sub = { toJSON: () => ({ endpoint: 'https://push.example/device', expirationTime: null, keys: { p256dh: 'public-device-key', auth: 'device-secret' } }) };
  const registration = { pushManager: {
    async getSubscription() { calls.push('existing'); return subscription; },
    async subscribe(options) { calls.push(options); return sub; }
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: {
    async register(url, options) { calls.push({ url, options }); return register ? register() : registration; }
  } } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission, requestPermission } });
  t.after(() => { for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const config = { configured: true, publicKey: 'AQID', preferences: { mention: true, dm: false } };
  const client = { session: { member: { id: 'owner' } },
    async humanPushConfig() { return config; },
    async saveHumanPush(value) { saved.push(value); return { saved: true }; },
    async saveHumanPushPreferences(value) { preferences.push(value); return { preferences: value }; }
  };
  const button = control(), note = control(), box = control(), mention = control(), dm = control();
  let eligible = true;
  const ui = installHumanPush({ client, button, note, prefs: { box, mention, dm }, eligible: () => eligible });
  return { ui, client, config, button, note, box, mention, dm, calls, saved, preferences, registration,
    signOut() { eligible = false; client.session = null; ui.reset(); } };
}

test('notification permission requires a click; granted subscription saves exact device bytes and preferences', async t => {
  let requests = 0;
  const f = setup(t, { requestPermission: async () => { requests++; return 'granted'; } });
  await f.ui.refresh();
  assert.equal(requests, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.button.hidden, false); assert.equal(f.mention.checked, true); assert.equal(f.dm.checked, false);
  await f.button.fire('click');
  assert.equal(requests, 1);
  assert.equal(new URL(f.calls[0].url).pathname.endsWith('/push-sw.js'), true);
  assert.equal(Object.hasOwn(f.calls[0].options, 'type'), false, 'iOS requires the classic worker');
  assert.deepEqual(f.calls[2], { userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(f.saved, [{ endpoint: 'https://push.example/device', expirationTime: null, keys: { p256dh: 'public-device-key', auth: 'device-secret' } }]);
  assert.equal(f.button.hidden, true); assert.match(f.note.textContent, /mention/i);
  f.mention.checked = false; f.dm.checked = true; await f.dm.fire('change');
  assert.deepEqual(f.preferences, [{ mention: false, dm: true }]);
  assert.match(f.note.textContent, /direct|DM/i);
});

test('permission denial never registers a worker or saves a device', async t => {
  const f = setup(t, { requestPermission: async () => 'denied' });
  await f.ui.refresh(); await f.button.fire('click');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
  assert.equal(f.button.hidden, true); assert.equal(f.note.hidden, false);
});

test('sign-out while permission is pending cannot register or revive notification controls', async t => {
  const pending = deferred(); const f = setup(t, { requestPermission: () => pending.promise });
  await f.ui.refresh(); const click = f.button.fire('click');
  await Promise.resolve(); f.signOut(); pending.resolve('granted'); await click;
  assert.deepEqual(f.calls, []); assert.deepEqual(f.saved, []);
  assert.equal(f.button.hidden, true); assert.equal(f.note.hidden, true); assert.equal(f.box.hidden, true);
});

test('sign-out during worker registration prevents saving the previous member subscription', async t => {
  const pending = deferred(); const started = deferred();
  const f = setup(t, { permission: 'granted', register: () => { started.resolve(); return pending.promise; } });
  const refresh = f.ui.refresh(); await started.promise; f.signOut(); pending.resolve(f.registration); await refresh;
  assert.deepEqual(f.saved, []); assert.equal(f.button.hidden, true); assert.equal(f.box.hidden, true);
});

test('existing browser subscription is reused without creating another push identity', async t => {
  const existing = { toJSON: () => ({ endpoint: 'https://push.example/existing', keys: { p256dh: 'existing-key', auth: 'existing-auth' } }) };
  const f = setup(t, { permission: 'granted', subscription: existing }); await f.ui.refresh();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1], 'existing');
  assert.deepEqual(f.saved, [{ endpoint: 'https://push.example/existing', expirationTime: null, keys: { p256dh: 'existing-key', auth: 'existing-auth' } }]);
});

test('failed preference save restores server-acknowledged values; stale completion cannot restore a signed-out UI', async t => {
  const f = setup(t); await f.ui.refresh();
  f.client.saveHumanPushPreferences = async () => { throw new Error('offline'); };
  f.mention.checked = false; f.dm.checked = true; await f.dm.fire('change');
  assert.equal(f.mention.checked, true); assert.equal(f.dm.checked, false);
  assert.equal(f.mention.disabled, false); assert.equal(f.dm.disabled, false);
  const pending = deferred(); f.client.saveHumanPushPreferences = () => pending.promise;
  f.dm.checked = true; const save = f.dm.fire('change'); f.signOut();
  pending.resolve({ preferences: { mention: false, dm: true } }); await save;
  assert.equal(f.box.hidden, true); assert.equal(f.note.hidden, true);
});

test('missing configuration, browser denial and server refusal never claim notification subscription success', async t => {
  const f = setup(t, { permission: 'denied' }); await f.ui.refresh();
  assert.deepEqual(f.saved, []); assert.equal(f.button.hidden, true);
  f.ui.reset(); f.config.configured = false; await f.ui.refresh();
  assert.deepEqual(f.saved, []); assert.equal(f.button.hidden, true);
  f.ui.reset(); f.config.configured = true; globalThis.Notification.permission = 'granted';
  f.client.saveHumanPush = async () => ({ saved: false }); await f.ui.refresh();
  assert.equal(f.button.hidden, true); assert.match(f.note.textContent, /could|try|failed|unable/i);
});
