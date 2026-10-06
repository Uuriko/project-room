// Account setup UI (src/account-setup-ui.js): the setup wizard's step flow.
// The fixture installs a minimal stub document so installAccountSetup (a
// browser module) runs under node. Covered contracts: the Gmail-unavailable
// two-step flow, OAuth resume from the persisted step, check() idempotence,
// reset(), the in-room name-only variant, and completed-setup silence.
import test from "node:test";
import assert from "node:assert/strict";
import { installAccountSetup } from "../src/account-setup-ui.js";

function installDom(t) {
  const created = [];
  function fire(el, type, event = {}) {
    for (const fn of el.handlers[type] ?? []) fn(event);
  }
  function fakeElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [], handlers: {}, dataset: {}, attrs: {},
      id: "", className: "", innerHTML: "", textContent: "", hidden: false,
      type: "", value: "", maxLength: 0, autocomplete: "", tabIndex: 0,
      open: false, disabled: false, isConnected: true, removed: false,
      focused: false, onclick: null,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { el.attrs[k] = v; },
      getAttribute(k) { return el.attrs[k] ?? null; },
      append(...kids) { el.children.push(...kids); return el; },
      appendChild(c) { el.children.push(c); return c; },
      replaceChildren(...kids) { el.children = kids; },
      addEventListener(type, fn) { (el.handlers[type] ??= []).push(fn); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      remove() { el.removed = true; },
      focus() { el.focused = true; },
      showModal() { el.open = true; },
      close() { el.open = false; fire(el, "close"); },
    };
    created.push(el);
    return el;
  }
  const body = fakeElement("body");
  const globals = { document: { createElement: fakeElement, body } };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return { created, body };
}

function apiStub({ setup, gmail }) {
  const calls = [];
  return {
    calls,
    request: async (path, opts) => {
      calls.push(path);
      if (path === "/setup") {
        if (opts?.method === "POST") Object.assign(setup, opts.data);
        return { setup };
      }
      if (path === "/gmail") return gmail;
      throw new Error("unexpected request: " + path);
    },
  };
}

const dialogOf = (body) => body.children.find((c) => c.tagName === "DIALOG");
const progressOf = (dialog) => dialog.children.find((c) => c.tagName === "P" && /Step \d of/.test(c.textContent));
const titleOf = (dialog) => dialog.children.find((c) => c.tagName === "H2");
const actionsOf = (dialog) => dialog.children.find((c) => c.className === "account-setup-actions");

test("setup skips the email step when Gmail is unavailable (two steps, not three)", async (t) => {
  const { body } = installDom(t);
  const api = apiStub({
    setup: { completed: false, step: 0, name: "Ava", purpose: "personal" },
    gmail: { state: "unavailable" },
  });
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() {} });
  await ui.check();
  const dialog = dialogOf(body);
  assert.ok(dialog.open, "dialog opens");
  assert.equal(progressOf(dialog).textContent, "Step 1 of 2");
  assert.equal(titleOf(dialog).textContent, "Make Project Room yours");
});

test("setup shows three steps when Gmail is available", async (t) => {
  const { body } = installDom(t);
  const api = apiStub({
    setup: { completed: false, step: 0, name: "Ava", purpose: "personal" },
    gmail: { state: "connected", address: "ava@example.com" },
  });
  // installAccountSetup returns the ui; check() drives load().
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() {} });
  await ui.check();
  assert.equal(progressOf(dialogOf(body)).textContent, "Step 1 of 3");
});

test("a persisted email step resumes past Gmail when Gmail is unavailable", async (t) => {
  const { body } = installDom(t);
  const api = apiStub({
    setup: { completed: false, step: 1, name: "Ava", purpose: "team" },
    gmail: { state: "unavailable" },
  });
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() {} });
  await ui.check();
  const dialog = dialogOf(body);
  // emailOff maps persisted step 1 -> step 2 ("You're ready"), never the email step.
  assert.equal(titleOf(dialog).textContent, "You’re ready");
  assert.equal(progressOf(dialog).textContent, "Step 2 of 2");
});

test("check() loads once; a forced check reloads", async (t) => {
  installDom(t);
  const api = apiStub({
    setup: { completed: false, step: 0, name: "Ava", purpose: "personal" },
    gmail: { state: "connected", address: "ava@example.com" },
  });
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() {} });
  await ui.check();
  await ui.check();
  assert.equal(api.calls.filter((c) => c === "/setup").length, 1, "second check does not re-fetch");
  await ui.check(true);
  assert.equal(api.calls.filter((c) => c === "/setup").length, 2, "forced check reloads");
});

test("reset() closes the dialog, clears the render, and allows a fresh check", async (t) => {
  const { body } = installDom(t);
  const api = apiStub({
    setup: { completed: false, step: 0, name: "Ava", purpose: "personal" },
    gmail: { state: "connected", address: "ava@example.com" },
  });
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() {} });
  await ui.check();
  const dialog = dialogOf(body);
  assert.ok(dialog.open, "dialog opens on first check");
  ui.reset();
  assert.equal(dialog.open, false, "reset closes the dialog");
  assert.deepEqual(dialog.children, [], "reset clears the render");
  await ui.check();
  assert.equal(api.calls.filter((c) => c === "/setup").length, 2, "reset allows a fresh check");
  assert.ok(dialog.open, "fresh check re-renders");
});

test("in-room setup asks for a name only: Done, no email detour, no set-up-later", async (t) => {
  const { body } = installDom(t);
  const api = apiStub({
    setup: { completed: false, step: 0, name: "", purpose: "" },
    gmail: { state: "connected", address: "ava@example.com" },
  });
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() {}, inRoom: () => true });
  await ui.check();
  const dialog = dialogOf(body);
  assert.equal(progressOf(dialog), undefined, "no step progress shown for name-only setup");
  const labels = actionsOf(dialog).children.map((b) => b.textContent);
  assert.deepEqual(labels, ["Done"], "name-only setup offers Done, not Continue / Set up later");
});

test("completed setup never renders the dialog and never checks Gmail", async (t) => {
  const { body } = installDom(t);
  const api = apiStub({
    setup: { completed: true, step: 2, name: "Ava", purpose: "team" },
    gmail: { state: "connected", address: "ava@example.com" },
  });
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() {} });
  await ui.check();
  const dialog = dialogOf(body);
  assert.equal(dialog.open, false, "dialog stays closed");
  assert.deepEqual(dialog.children, [], "nothing renders");
  assert.ok(!api.calls.includes("/gmail"), "Gmail is not consulted for completed setup");
});
