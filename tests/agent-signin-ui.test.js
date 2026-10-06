// Agent sign-in UI phase lifecycle (src/agent-signin-ui.js).
// tests/agent-signin-autocomplete.test.js owns the autocomplete contract;
// this file owns the uncovered surface: the initial phase, the
// credentials <-> create-identity navigation, and hide/show. No network is
// touched: phase switches are synchronous in the click handler.
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

function mounted() {
  const ui = createAgentSigninUI({ onSignedIn() {}, firstRunActions: {} });
  const container = fakeContainer();
  ui.mount(container);
  return { ui, container };
}

// Fire the container's click handler with a target matching `selector`.
function click(container, selector) {
  const handler = container.listeners.click[0];
  return handler({ target: { closest: (sel) => (sel === selector ? {} : null) } });
}

test("mount starts on the credentials phase with the create-identity affordance", () => {
  const { container } = mounted();
  assert.match(container.innerHTML, /<form data-agent-form="credentials"/, "credentials form first");
  assert.match(container.innerHTML, /data-agent-new/, "create-identity button present");
});

test("create-identity navigates to the create phase and back without network", async () => {
  const { container } = mounted();
  await click(container, "[data-agent-new]");
  assert.match(container.innerHTML, /<form data-agent-form="create"/, "create phase renders");
  assert.match(container.innerHTML, /I already have an identity/, "back-to-signin affordance");
  await click(container, "[data-agent-back-to-signin]");
  assert.match(container.innerHTML, /<form data-agent-form="credentials"/, "returns to credentials");
});

test("the create form disables autocomplete so password managers skip identity creation", () => {
  const { container } = mounted();
  return click(container, "[data-agent-new]").then(() => {
    assert.match(container.innerHTML, /<form data-agent-form="create"[^>]*autocomplete="off"/);
  });
});

test("hide/show toggles visibility and show() resets to the credentials phase", async () => {
  const { ui, container } = mounted();
  await click(container, "[data-agent-new]");
  assert.match(container.innerHTML, /<form data-agent-form="create"/);
  ui.hide();
  assert.equal(container.hidden, true);
  ui.show();
  assert.equal(container.hidden, false);
  assert.match(container.innerHTML, /<form data-agent-form="credentials"/, "show() returns to credentials");
});
