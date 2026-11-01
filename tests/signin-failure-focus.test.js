// A failed password sign-in repaints the form; focus must land back on the
// password field instead of falling to <body>.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

test("failed password login returns focus to the password field", async () => {
  const body = { tag: "BODY" };
  const doc = { body, activeElement: null, getElementById: () => null };
  globalThis.document = doc;
  const make = name => ({ name, getClientRects: () => [1], focus() { doc.activeElement = this; } });
  let fields = { email: make("email"), password: make("password"), submit: make("submit") };
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  const container = {
    _html: "",
    get innerHTML() { return this._html; },
    // innerHTML replacement destroys the old nodes: focus falls to <body>.
    set innerHTML(v) { this._html = v; fields = { email: make("email"), password: make("password"), submit: make("submit") }; doc.activeElement = body; },
    addEventListener(n, fn) { (listeners[n] ??= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { if (sel === "[data-signin-status]") return status; const m = sel.match(/name="(\w+)"/); return m ? fields[m[1]] ?? null : null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    contains(el) { return !!el && el !== body; },
  };
  const err = Object.assign(new Error("Invalid email or password"), { status: 401, code: "invalid_credentials" });
  const accountClient = {
    generation: 0,
    session: { authenticated: false, csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1 },
    currentSession() { return this.session; },
    owns(g, s) { return this.generation === g && this.session === s; },
    invalidate() { return false; },
    async restore() { return { authenticated: false }; },
    async request() { throw err; },
  };
  const ui = createAuthSigninUI({ accountClient, ensureAccountSession: async () => {}, onSignedIn: async () => {} });
  ui.mount(container);
  fields.submit.focus();
  const form = { dataset: { signinForm: "password" }, querySelectorAll: () => [{ name: "email", value: "nobody@example.com" }, { name: "password", value: "wrong-password" }] };
  for (const fn of listeners.submit ?? []) await fn({ preventDefault() {}, target: { closest: s => s === "[data-signin-form]" ? form : null } });
  await new Promise(r => setTimeout(r, 20));
  assert.match(status.textContent, /Invalid|could not|failed|try/i, "error shown");
  assert.equal(doc.activeElement?.name, "password", "focus back on the password field, not <body>");
  delete globalThis.document;
});
