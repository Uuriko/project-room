// A failed password sign-in repaints the form; focus must land back on the
// password field instead of falling to <body>.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

async function pendingLogin(t) {
  const body = { tag: "BODY" };
  const focusListeners = new Set();
  const doc = { body, activeElement: body, getElementById: () => null,
    addEventListener(type, fn) { if (type === "focusin") focusListeners.add(fn); },
    removeEventListener(type, fn) { if (type === "focusin") focusListeners.delete(fn); },
  };
  const previous = globalThis.document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  globalThis.document = doc;
  const make = name => ({ name, getClientRects: () => [1], focus() { doc.activeElement = this; for (const fn of focusListeners) fn({ target: this }); } });
  let fields = { email: make("email"), password: make("password"), submit: make("submit") };
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  const form = { dataset: { signinForm: "password" }, querySelectorAll: () => [{ name: "email", value: "nobody@example.com" }, { name: "password", value: "wrong-password" }] };
  const container = {
    _html: "", isConnected: true, hidden: false,
    closest() { return this.hidden ? this : null; },
    getClientRects() { return this.hidden || !this.isConnected ? [] : [1]; },
    get innerHTML() { return this._html; },
    // innerHTML replacement destroys the old nodes: focus falls to <body>.
    set innerHTML(v) { if (this.contains(doc.activeElement)) doc.activeElement = body; this._html = v; fields = { email: make("email"), password: make("password"), submit: make("submit") }; },
    addEventListener(n, fn) { (listeners[n] ??= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { if (sel === "[data-signin-status]") return status; const m = sel.match(/name="(\w+)"/); return m ? fields[m[1]] ?? null : null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    contains(el) { return el === form || Object.values(fields).includes(el); },
  };
  const err = Object.assign(new Error("Invalid email or password"), { status: 401, code: "invalid_credentials" });
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const accountClient = {
    generation: 0,
    session: { authenticated: false, csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1 },
    currentSession() { return this.session; },
    owns(g, s) { return this.generation === g && this.session === s; },
    invalidate() { return false; },
    async restore() { return { authenticated: false }; },
    async request() { started.resolve(); return pending.promise; },
  };
  const ui = createAuthSigninUI({ accountClient, ensureAccountSession: async () => {}, onSignedIn: async () => {} });
  ui.mount(container);
  fields.submit.focus();
  const completion = listeners.submit[0]({ preventDefault() {}, target: { closest: s => s === "[data-signin-form]" ? form : null } });
  await started.promise;
  return { doc, body, container, ui, outside: make("outside"), focusListeners,
    async reject() { pending.reject(err); await completion; assert.equal(focusListeners.size, 0); },
    status };
}

test("failed password login returns focus to the password field", async t => {
  const f = await pendingLogin(t);
  await f.reject();
  assert.match(f.status.textContent, /Invalid|could not|failed|try/i);
  assert.equal(f.doc.activeElement?.name, "password");
});

for (const mode of ["outside", "outside-then-blur", "hidden", "detached", "unmounted"]) {
  test(`late password failure does not reclaim focus after ${mode}`, async t => {
    const f = await pendingLogin(t);
    if (mode.startsWith("outside")) f.outside.focus();
    if (mode === "outside-then-blur") f.doc.activeElement = f.body;
    if (mode === "hidden") f.container.hidden = true;
    if (mode === "detached") f.container.isConnected = false;
    if (mode === "unmounted") f.ui.unmount();
    const focused = f.doc.activeElement;
    await f.reject();
    assert.equal(f.doc.activeElement, focused);
  });
}
