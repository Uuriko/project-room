// WAVE-500 G1 worker 40: a stranger who uses a passkey or an email sign-in
// link as their primary method lands on the password "Log in" form and has
// no way to start either — both are buried behind the wrongly-labeled
// "Forgot password?" control. The log-in form must surface both affordances
// directly. Fail-first: these assertions fail until the form offers them.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

function mount({ credentials } = {}) {
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  const container = {
    status, innerHTML: "", listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); }, removeEventListener() {},
    querySelector: sel => sel === "[data-signin-status]" ? status : null,
    setAttribute() {}, querySelectorAll: () => [], contains: () => true
  };
  const client = { generation: 0, session: { authenticated: false }, currentSession() { return this.session; }, owns: () => true, invalidate: () => true, async restore() { return null; }, async request() { return null; } };
  createAuthSigninUI({ accountClient: client, ensureAccountSession: async () => {}, onSignedIn: async () => {}, credentials }).mount(container);
  return container;
}

test("log-in form offers a passkey affordance when the browser supports it", () => {
  const container = mount({ credentials: { get() {} } });
  assert.match(container.innerHTML, /data-passkey-signin/, "log-in form shows Use a passkey");
});

test("log-in form offers an email sign-in link affordance", () => {
  const container = mount();
  assert.match(container.innerHTML, /data-email-method="magic"/, "log-in form shows Email me a sign-in link");
});

test("sign-up form does not grow the passwordless affordances", () => {
  const container = mount({ credentials: { get() {} } });
  const toggle = ({ target: { closest: sel => sel.includes("data-password-mode") ? { dataset: { passwordMode: "signup" } } : null } });
  return container.listeners.click[0](toggle).then(() => {
    assert.doesNotMatch(container.innerHTML, /data-passkey-signin/, "sign-up form keeps no passkey button");
    assert.doesNotMatch(container.innerHTML, /data-email-method="magic"/, "sign-up form keeps no magic-link button");
  });
});
