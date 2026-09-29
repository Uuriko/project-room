// Email link UI contracts against a strict AccountClient double.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";
function fakeContainer() {
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  return {
    status,
    innerHTML: "",
    listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); },
    querySelector(selector) { return selector === "[data-signin-status]" ? status : null; },
    contains() { return true; },
    fire(name, event) { for (const fn of listeners[name] ?? []) fn(event); }
  };
}

const attrFor = sel => (sel.match(/\[data-([a-z-]+)\]/) ?? [])[1];
const clickOnDataset = (kind, dataset = {}) => ({ target: { closest: sel => attrFor(sel) === kind ? { dataset } : null } });
const submitForm = (kind, values = {}) => ({
  preventDefault() {},
  target: { closest: sel => sel === "[data-signin-form]" ? {
    dataset: { signinForm: kind },
    querySelectorAll: () => Object.entries(values).map(([name, value]) => ({ name, value }))
  } : null }
});

function stubClient(routes = {}) {
  const calls = [];
  return {
    calls,
    generation: 0,
    session: { authenticated: false, csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1 },
    currentSession() { return this.session; },
    owns(generation, session) { return this.generation === generation && this.session === session; },
    invalidate(generation, session) { if (!this.owns(generation, session)) return false; this.generation++; this.session = null; return true; },
    async request(path, { data } = {}) {
      calls.push({ path, data });
      const reply = routes[path];
      const resolved = typeof reply === "function" ? reply(data) : reply;
      if (resolved?.throw) throw Object.assign(new Error(resolved.throw.message), { code: resolved.throw.code });
      return resolved;
    }
  };
}

function mount(routes = {}) {
  const client = stubClient(routes);
  const signins = [];
  const ui = createAuthSigninUI({
    accountClient: client,
    ensureAccountSession: async () => {},
    onSignedIn: async session => { signins.push(session); }
  });
  const container = fakeContainer();
  ui.mount(container);
  return { client, signins, container, ui };
}


test("email entry exposes only a delivered-link request", () => {
  const { container } = mount();
  assert.match(container.innerHTML, /data-signin-form="magic-request"/);
  assert.doesNotMatch(container.innerHTML, /type="password"|passkey|recovery|GitHub|data-method|name="code"/i);
});
test("unconfigured delivery stays visible after pending state clears", async () => {
  const { container, ui } = mount({ "/api/auth/magic/request": { status: "unavailable", message: "Delivery unavailable" } });
  await container.listeners.submit[0](submitForm("magic-request", { email: "m@example.invalid" }));
  assert.equal(ui.canLeave(), true);
  assert.equal(container.status.textContent, "Delivery unavailable");
  assert.match(container.innerHTML, /role="alert"/);
});
test("delivered email offers verification code only after explicit selection", async () => {
  const { container, client, signins } = mount({ "/api/auth/magic/request": { status: "sent" }, "/api/auth/magic/consume": { authenticated: true, account: { id: "a" } } });
  await container.listeners.submit[0](submitForm("magic-request", { email: "m@example.invalid" }));
  assert.match(container.innerHTML, /Check m@example.invalid/);
  assert.doesNotMatch(container.innerHTML, /name="code"/);
  await container.listeners.click[0](clickOnDataset("magic-manual-code"));
  assert.match(container.innerHTML, /name="code"/);
  await container.listeners.submit[0](submitForm("magic-code", { code: "synthetic-code" }));
  assert.equal(client.calls[1].path, "/api/auth/magic/consume"); assert.equal(signins.length, 1);
});
test("email request carries the host's invitation destination without authenticating", async () => {
  const client = stubClient({ "/api/auth/magic/request": { status: "sent" } }); let signed = 0;
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => signed++, onMagicLinkRequest: () => "/#invite/synthetic" });
  const container = fakeContainer(); ui.mount(container);
  await container.listeners.submit[0](submitForm("magic-request", { email: "m@example.invalid" }));
  assert.equal(client.calls[0].data.returnTo, "/#invite/synthetic"); assert.equal(signed, 0);
});
async function readyCode(ui, container) {
  ui.showMagic();
  await container.listeners.submit[0](submitForm("magic-request", { email: "m@example.invalid" }));
  await container.listeners.click[0](clickOnDataset("magic-manual-code"));
}
test("pending authentication prevents leaving until its actual result", async () => {
  let release; const pending = new Promise(resolve => release = resolve); const lifecycle = [];
  const client = stubClient({ "/api/auth/magic/request": { status: "sent" }, "/api/auth/magic/consume": () => pending });
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => {}, onBusyChange: value => lifecycle.push(value) });
  const container = fakeContainer(); ui.mount(container); await readyCode(ui, container); lifecycle.length = 0;
  const submission = container.listeners.submit[0](submitForm("magic-code", { code: "code" }));
  await Promise.resolve();
  assert.equal(ui.canLeave(), false); assert.equal(ui.closeEmail(), false);
  release({ authenticated: true, account: { id: "a" } }); await submission;
  assert.deepEqual(lifecycle, [true, false]); assert.equal(ui.canLeave(), true);
});
test("declining authentication causes no consume request or pending lifecycle", async () => {
  const client = stubClient({ "/api/auth/magic/request": { status: "sent" } }); const lifecycle = [];
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => {}, beforeSignIn: () => false, onBusyChange: value => lifecycle.push(value) });
  const container = fakeContainer(); ui.mount(container); await readyCode(ui, container); lifecycle.length = 0;
  await container.listeners.submit[0](submitForm("magic-code", { code: "code" }));
  assert.equal(client.calls.length, 1); assert.deepEqual(lifecycle, []);
});
test("lost consume result fences only the identity that issued it", async () => {
  const client = stubClient({ "/api/auth/magic/request": { status: "sent" }, "/api/auth/magic/consume": { throw: { message: "Connection lost" } } });
  let fenced = 0, signed = 0;
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => signed++, onSignInUncertain: () => fenced++ });
  const container = fakeContainer(); ui.mount(container); await readyCode(ui, container);
  await container.listeners.submit[0](submitForm("magic-code", { code: "code" }));
  assert.equal(client.session, null); assert.equal(fenced, 1); assert.equal(signed, 0);
});
test("late consume cannot complete or clear a replacement identity", async () => {
  let release; const pending = new Promise(resolve => release = resolve);
  const client = stubClient({ "/api/auth/magic/request": { status: "sent" }, "/api/auth/magic/consume": () => pending }); let signed = 0, fenced = 0;
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => signed++, onSignInUncertain: () => fenced++ });
  const container = fakeContainer(); ui.mount(container); await readyCode(ui, container);
  const submission = container.listeners.submit[0](submitForm("magic-code", { code: "code" }));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const replacement = { authenticated: true, account: { id: "new" } }; client.generation++; client.session = replacement;
  release({ authenticated: true, account: { id: "old" } }); await submission;
  assert.equal(client.session, replacement); assert.equal(signed, 0); assert.equal(fenced, 0);
});
test("different-account rejection offers an explicit switch without logging out automatically", async () => {
  const client = stubClient({ "/api/auth/magic/request": { status: "sent" } }); let logouts = 0;
  client.request = async path => { if (path.endsWith("request")) return { status: "sent" }; throw Object.assign(new Error("Different account"), { status: 409, code: "magic_account_mismatch" }); };
  client.logout = async () => { logouts++; };
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => {}, onAccountSwitch: () => false });
  const container = fakeContainer(); ui.mount(container); await readyCode(ui, container);
  await container.listeners.submit[0](submitForm("magic-code", { code: "code" }));
  assert.match(container.innerHTML, /data-magic-switch/);
  await container.listeners.click[0](clickOnDataset("magic-switch")); assert.equal(logouts, 0);
});

test("confirmed different-account switch logs out once and retries the unburned link", async () => {
  const client = stubClient(); let consumes = 0, logouts = 0, reconciled = 0, signed = 0; const codes = [];
  client.request = async (path, { data }) => {
    if (path.endsWith("request")) return { status: "sent" };
    codes.push(data.code);
    if (++consumes === 1) throw Object.assign(new Error("Different account"), { status: 409, code: "magic_account_mismatch" });
    return { authenticated: true, account: { id: "target" } };
  };
  client.logout = async () => { logouts++; client.generation++; client.session = { authenticated: false, sessionRevision: 2 }; return client.session; };
  const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => signed++, onAccountSwitch: () => true, onSignInUncertain: () => reconciled++ });
  const container = fakeContainer(); ui.mount(container); await readyCode(ui, container);
  await container.listeners.submit[0](submitForm("magic-code", { code: "same-unburned-code" }));
  await container.listeners.click[0](clickOnDataset("magic-switch"));
  assert.equal(logouts, 1); assert.equal(reconciled, 1); assert.equal(consumes, 2); assert.equal(signed, 1);
  assert.deepEqual(codes, ["same-unburned-code", "same-unburned-code"]);
});

test("contextual password login and creation use the guarded authentication routes", async () => {
  const { ui, container, client, signins } = mount({ "/api/auth/password/login": { authenticated: true, account: { id: "a" } }, "/api/auth/password/signup": { authenticated: true, account: { id: "b" } } });
  await container.listeners.click[0](clickOnDataset("email-method", { emailMethod: "password" }));
  assert.match(container.innerHTML, /autocomplete="current-password"/);
  await container.listeners.submit[0](submitForm("password", { email: "p@example.invalid", password: "synthetic-password" }));
  assert.equal(client.calls[0].path, "/api/auth/password/login");
  assert.doesNotMatch(container.innerHTML, /value="synthetic-password"/);
  await container.listeners.click[0](clickOnDataset("password-mode", { passwordMode: "signup" }));
  assert.match(container.innerHTML, /autocomplete="new-password"/);
  await container.listeners.submit[0](submitForm("password", { email: "p@example.invalid", password: "synthetic-password" }));
  assert.equal(client.calls[1].path, "/api/auth/password/signup"); assert.equal(signins.length, 2);
  await container.listeners.click[0](clickOnDataset("email-method", { emailMethod: "magic" }));
  assert.match(container.innerHTML, /data-signin-form="magic-request"/); ui.clear();
  assert.doesNotMatch(container.innerHTML, /p@example.invalid/);
});
test("declining password authentication sends no request", async () => {
  const client = stubClient(); const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => {}, beforeSignIn: () => false });
  const container = fakeContainer(); ui.mount(container);
  await container.listeners.click[0](clickOnDataset("email-method", { emailMethod: "password" }));
  await container.listeners.submit[0](submitForm("password", { email: "p@example.invalid", password: "synthetic-password" }));
  assert.equal(client.calls.length, 0); assert.equal(ui.canLeave(), true);
});

for (const view of [{}, { authenticated: true, account: { id: "" } }, { session: { authenticated: false, account: { id: "a" } } }]) {
  test(`invalid authentication success reconciles only the issuing identity: ${JSON.stringify(view)}`, async () => {
    const client = stubClient({ "/api/auth/magic/request": { status: "sent" }, "/api/auth/magic/consume": view });
    const old = { authenticated: true, account: { id: "old" }, sessionRevision: 1 }; client.session = old; client.generation = 4;
    let fenced = 0, signed = 0;
    const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: () => signed++, onSignInUncertain: () => fenced++ });
    const container = fakeContainer(); ui.mount(container); await readyCode(ui, container);
    await container.listeners.submit[0](submitForm("magic-code", { code: "real-issued-code" }));
    assert.equal(client.session, null); assert.equal(client.generation, 5); assert.equal(fenced, 1); assert.equal(signed, 0);
    assert.match(container.status.textContent, /didn.t complete/);
  });
}
