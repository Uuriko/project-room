// The panel-level #auth-error notice set after sign-out (e.g. "Session ended;
// private drafts were cleared.") must not sit beside a fresh sign-in error.
// When the sign-in form announces a new outcome, the stale panel notice clears.
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
    setAttribute() {},
    querySelectorAll() { return []; },
    contains() { return true; }
  };
}
const submitForm = (kind, values = {}) => ({
  preventDefault() {},
  target: { closest: sel => sel === "[data-signin-form]" ? {
    dataset: { signinForm: kind },
    querySelectorAll: () => Object.entries(values).map(([name, value]) => ({ name, value }))
  } : null }
});
function stubClient(routes = {}) {
  return {
    generation: 0,
    session: { authenticated: false, csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1 },
    currentSession() { return this.session; },
    owns() { return true; },
    invalidate() { return true; },
    async restore() { return { authenticated: true, account: { id: "restored" } }; },
    async request(path, { data } = {}) {
      const reply = routes[path];
      const resolved = typeof reply === "function" ? reply(data) : reply;
      if (resolved?.throw) throw Object.assign(new Error(resolved.throw.message), { code: resolved.throw.code });
      return resolved;
    }
  };
}
test("wrong-password login clears the stale session-ended panel notice", async () => {
  const panelNotice = { textContent: "Session ended; private drafts were cleared." };
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById(id) { return id === "auth-error" ? panelNotice : null; } };
  try {
    const client = stubClient({ "/api/auth/password/login": { throw: { message: "Invalid email or password", code: "invalid_credentials" } } });
    const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {} });
    const container = fakeContainer();
    ui.mount(container);
    await container.listeners.submit[0](submitForm("password", { email: "person@example.invalid", password: "Totally-wrong-pass!" }));
    assert.equal(container.status.textContent, "Invalid email or password");
    assert.equal(panelNotice.textContent, "", "stale #auth-error must be empty once the sign-in form shows its own error");
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});
test("empty sign-in status does not clear the panel notice", async () => {
  const panelNotice = { textContent: "Session ended; private drafts were cleared." };
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById(id) { return id === "auth-error" ? panelNotice : null; } };
  try {
    const client = stubClient();
    const ui = createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {} });
    const container = fakeContainer();
    ui.mount(container);
    assert.equal(panelNotice.textContent, "Session ended; private drafts were cleared.");
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  }
});
