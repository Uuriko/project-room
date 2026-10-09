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
  assert.equal(dialog.open, false, "untouched optional setup stays closed");
  assert.equal(api.calls.includes("/gmail"), false, "deferred setup does not load an optional connector");
  await ui.check(true);
  assert.ok(dialog.open, "explicit personalization opens the dialog");
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
  assert.equal(dialogOf(body).open, false, "first use does not open optional setup");
  await ui.check(true);
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
  assert.equal(dialog.open, false, "first check leaves optional setup closed");
  await ui.check(true);
  assert.ok(dialog.open, "explicit personalization opens before reset");
  ui.reset();
  assert.equal(dialog.open, false, "reset closes the dialog");
  assert.deepEqual(dialog.children, [], "reset clears the render");
  await ui.check();
  assert.equal(api.calls.filter((c) => c === "/setup").length, 3, "reset allows a fresh check after explicit setup");
  assert.equal(dialog.open, false, "reset does not reintroduce automatic optional setup");
  await ui.check(true);
  assert.ok(dialog.open, "explicit personalization re-renders after reset");
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
  assert.equal(dialog.open, false, "entering a room does not interrupt with optional setup");
  await ui.check(true);
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


test("an explicit room-name request opens deferred setup and resolves after saving", async t => {
  const { body } = installDom(t);
  const setup = { completed: false, step: 0, name: "Ava", purpose: "personal" };
  const api = apiStub({ setup, gmail: { state: "unavailable" } });
  let roomVisits = 0;
  const ui = installAccountSetup({ api, owns: () => true, onInbox() {}, onRoom() { roomVisits++; } });
  await ui.check();
  const dialog = dialogOf(body);
  assert.equal(dialog.open, false);
  const naming = ui.askName();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialog.open, true, "a user-requested name prompt still opens after deferred first use");
  assert.deepEqual(actionsOf(dialog).children.map(button => button.textContent), ["Done"]);
  actionsOf(dialog).children[0].onclick();
  await naming;
  assert.equal(dialog.open, false);
  assert.equal(setup.completed, true);
  assert.equal(setup.name, "Ava");
  assert.equal(roomVisits, 0, "name-only completion does not create or navigate another room");
});

// QA8: password signup used to make the first room before asking for a name,
// so the owner joined as "Owner". nameBeforeFirstRoom asks first.
import { nameBeforeFirstRoom } from "../src/account-setup-ui.js";

test("first room: the name is asked before the room is made", async () => {
  const calls = [];
  const run = nameBeforeFirstRoom({
    askName: async () => { calls.push("ask"); },
    ensure: async () => { calls.push("ensure"); return { room: { id: "r1" } }; },
    session: () => "s1" });
  assert.deepEqual(await run(), { room: { id: "r1" } });
  assert.deepEqual(calls, ["ask", "ensure"]);
});

test("first room: two loads share one dialog and one room request", async () => {
  let release, asks = 0, ensures = 0;
  const run = nameBeforeFirstRoom({
    askName: () => { asks++; return new Promise(done => { release = done; }); },
    ensure: async () => { ensures++; return { room: { id: "r1" } }; },
    session: () => "s1" });
  const a = run(), b = run();
  assert.equal(a, b);
  release();
  await a;
  assert.equal(asks, 1);
  assert.equal(ensures, 1);
});

test("first room: a session change during the dialog makes no room", async () => {
  let session = "s1", ensures = 0;
  const run = nameBeforeFirstRoom({
    askName: async () => { session = "s2"; },
    ensure: async () => { ensures++; return { room: { id: "r1" } }; },
    session: () => session });
  assert.equal(await run(), null);
  assert.equal(ensures, 0);
});

test("first room: a failed setup read still makes the room", async () => {
  let ensures = 0;
  const run = nameBeforeFirstRoom({
    askName: async () => { throw new Error("setup unavailable"); },
    ensure: async () => { ensures++; return { room: { id: "r1" } }; },
    session: () => "s1" });
  assert.deepEqual(await run(), { room: { id: "r1" } });
  assert.equal(ensures, 1);
});
