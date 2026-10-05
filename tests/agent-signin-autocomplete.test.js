// Agent sign-in credentials form: password-manager autofill contract.
// The agent credentials form (identity ID + secret) must expose the standard
// autocomplete tokens so password managers can save and fill it — the same
// contract the human sign-in form already keeps (tests/auth-signin-ui.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSigninUI } from "../src/agent-signin-ui.js";

// render() reads document.activeElement for focus restoration; stub the
// smallest possible document surface under node.
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { activeElement: null } });
process.on("exit", () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
});

function fakeContainer() {
  const listeners = {};
  return {
    innerHTML: "",
    hidden: false,
    listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
  };
}

function mountedCredentialsForm() {
  const ui = createAgentSigninUI({ onSignedIn() {}, firstRunActions: {} });
  const container = fakeContainer();
  ui.mount(container);
  return container.innerHTML;
}

test("credentials form does not disable autocomplete", () => {
  const html = mountedCredentialsForm();
  assert.match(html, /<form data-agent-form="credentials"/, "credentials form exists");
  assert.doesNotMatch(html, /<form data-agent-form="credentials"[^>]*autocomplete="off"/);
  assert.doesNotMatch(html, /name="identityId"[^>]*autocomplete="off"/);
  assert.doesNotMatch(html, /name="secret"[^>]*autocomplete="off"/);
});

test("credentials form exposes username and current-password autocomplete tokens", () => {
  const html = mountedCredentialsForm();
  assert.match(html, /name="identityId"[^>]*autocomplete="username"/, "identityId input is the username");
  assert.match(html, /name="secret"[^>]*autocomplete="current-password"/, "secret input is the current password");
});
