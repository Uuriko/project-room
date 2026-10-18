import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

// #3771 (F-12) regression pin: switching the merged sign-in form between
// Log in and Create account re-renders the panel, and the typed password
// used to vanish (17 -> 0 in QA — on the sign-in wall AND in the join
// panel, which mount this same component) while the email survived.
// The fake container models the one browser behaviour that matters here:
// setting innerHTML destroys the old input nodes, so a fresh password
// input is born EMPTY and a fresh email input is born with the value the
// template carries (the component's passwordEmail state). Anything the
// component does not explicitly carry across the render is lost — like
// the browser.

function fakeContainer() {
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  const container = {
    status,
    listeners,
    inputs: null,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); },
    setAttribute() {},
    contains() { return true; },
    fire(name, event) { for (const fn of listeners[name] ?? []) fn(event); },
    querySelector(selector) {
      if (selector === "[data-signin-status]") return status;
      if (selector === '[name="email"]') return container.inputs?.email ?? null;
      if (selector === '[name="password"]') return container.inputs?.password ?? null;
      return null;
    },
    querySelectorAll() {
      return container.inputs ? [container.inputs.email, container.inputs.password] : [];
    },
  };
  let html = "";
  Object.defineProperty(container, "innerHTML", {
    get() { return html; },
    set(value) {
      html = value;
      // Browser semantics: old nodes are destroyed. The email template
      // carries passwordEmail (already synced from the old node by the
      // switch handler); the password template carries no value at all.
      const emailValue = /name="email"[^>]* value="([^"]*)"/.exec(value)?.[1] ?? "";
      container.inputs = value.includes('data-signin-form="password"') ? {
        email: { name: "email", value: emailValue, disabled: false, focus() {} },
        password: { name: "password", value: "", disabled: false, focus() {} },
      } : null;
    },
  });
  return container;
}

const attrFor = sel => (sel.match(/\[data-([a-z-]+)\]/) ?? [])[1];
const clickMode = mode => ({ target: { closest: sel => attrFor(sel) === "password-mode" ? { dataset: { passwordMode: mode } } : null } });

function mount() {
  const client = {
    generation: 0,
    session: { authenticated: false, csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1 },
    currentSession() { return this.session; },
    owns(generation, session) { return this.generation === generation && this.session === session; },
    async request() { throw new Error("no routes in this test"); },
  };
  const ui = createAuthSigninUI({
    accountClient: client,
    ensureAccountSession: async () => {},
    onSignedIn: async () => {},
  });
  const container = fakeContainer();
  ui.mount(container);
  return { ui, container };
}

test("mode switch login -> signup -> login preserves the typed password (17 -> 17, never 0)", () => {
  const { container } = mount();
  container.inputs.email.value = "founder@example.com";
  container.inputs.password.value = "12345678901234567"; // the QA probe's 17-char password
  container.fire("click", clickMode("signup"));
  assert.equal(container.inputs.email.value, "founder@example.com", "email preserved across the switch");
  assert.equal(container.inputs.password.value.length, 17, "password preserved across login -> signup");
  container.fire("click", clickMode("login"));
  assert.equal(container.inputs.password.value, "12345678901234567", "password preserved across signup -> login");
});

test("clear() still wipes the password (sign-out must not retain the draft)", () => {
  const { ui, container } = mount();
  container.inputs.password.value = "12345678901234567";
  container.fire("click", clickMode("signup"));
  assert.equal(container.inputs.password.value.length, 17);
  ui.clear();
  assert.equal(container.inputs.password.value, "", "clear() blanks the live input");
  container.fire("click", clickMode("login"));
  assert.equal(container.inputs.password.value, "", "and no later render resurrects it");
});
