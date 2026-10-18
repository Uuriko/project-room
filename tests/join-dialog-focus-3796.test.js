// #3796: the join dialog after account creation — silent state change,
// focus dropped to <body>, and no focus trap.
//
// QA Wave B2 (keyboard-only): the visitor creates an account inside
// #join-link-dialog; the account is created, the dialog re-renders into
// the name step with the name pre-filled from the email prefix, but
// nothing announces the step or that another action is required, focus
// lands on <body>, and Tab walks out of the dialog into the page
// behind. Pins:
//  1. Reaching the name step via sign-in (afterSignIn) announces the
//     step and its completion action in the live status, pre-fills the
//     name from the account, and lands focus on the name field.
//  2. Tab / Shift+Tab cycle inside the dialog (the account-settings
//     deletion-dialog idiom), including when focus has fallen outside
//     the dialog's controls entirely.
import test from "node:test";
import assert from "node:assert/strict";
import { installShareLinks } from "../src/share-links.js";

const joinDom = () => {
  const nodes = new Map();
  let focused = null;
  const controls = ["#join-link-name", "#join-link-submit", "#join-link-close"];
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { toggle() {} }, addEventListener(type, handler) { this.handlers[type] = handler; },
      contains() { return false; }, replaceChildren() {}, reset() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() { focused = selector; },
      querySelectorAll() { return controls.map(node); },
    });
    return nodes.get(selector);
  };
  const dialog = node("#join-link-dialog");
  dialog.contains = el => controls.map(node).includes(el);
  const storage = new Map();
  const localStorage = { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); }, removeItem: k => { storage.delete(k); } };
  const joinStorage = new Map();
  const sessionStorage = { getItem: k => (joinStorage.has(k) ? joinStorage.get(k) : null), setItem: (k, v) => { joinStorage.set(k, String(v)); }, removeItem: k => { joinStorage.delete(k); } };
  const location = { hostname: "localhost", origin: "http://localhost:52331", hash: "" };
  const document = { querySelector: node, activeElement: null };
  const globals = { document, window: { addEventListener() {}, sessionStorage }, location, localStorage, sessionStorage };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = () => { for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const uninstall = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  return { node, document, focused: () => focused, install, uninstall };
};

const preview = {
  room: { id: "commons", title: "Commons" }, access: "Conversation only.",
  link: { status: "active", access: "guest", expiresAt: Date.now() + 3600000, remainingJoins: 2 },
};

test("#3796: signing in inside the join dialog announces the name step and lands focus on it", async () => {
  const dom = joinDom();
  const accountClient = {
    session: { authenticated: true, account: { id: "acct_3796" } },
    async prepareShareLink() { return { session: this.session, preview }; },
    currentSession() { return this.session; },
    async request(path) {
      if (path === "/api/auth/methods") return { methods: [{ email: "priya@example.test" }], emailVerification: { status: "verified" }, providers: {} };
      if (path === "/api/account/profile") return {};
      throw new Error(`unexpected ${path}`);
    },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, openRoom() {} });
    await ui.open({ token: "n".repeat(43) }, { afterSignIn: true });
    assert.equal(dom.node("#join-link-name").value, "priya", "the name is pre-filled from the account email");
    assert.match(dom.node("#join-link-status").textContent, /You're signed in\. One more step: confirm the name/,
      "the step and its completion action are announced, not a silent state change");
    assert.match(dom.node("#join-link-status").textContent, /Join room/);
    assert.equal(dom.focused(), "#join-link-name", "focus lands on the name field, not <body>");
  } finally { dom.uninstall(); }
});

test("#3796: Tab cycles inside the join dialog, including from outside its controls", async () => {
  const dom = joinDom();
  const accountClient = {
    session: {},
    async prepareShareLink() { return { session: this.session, preview }; },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, openRoom() {} });
    await ui.open({ token: "n".repeat(43) });
    const dialog = dom.node("#join-link-dialog");
    assert.equal(typeof dialog.handlers.keydown, "function", "the dialog traps Tab");
    let prevented = 0;
    const tab = (shiftKey, active) => {
      prevented = 0; dom.document.activeElement = active;
      dialog.handlers.keydown({ key: "Tab", shiftKey, preventDefault() { prevented++; } });
      return prevented;
    };
    // Focus fell to <body> (outside the controls): Tab enters at the first control.
    assert.equal(tab(false, null), 1);
    assert.equal(dom.focused(), "#join-link-name");
    // Shift+Tab from outside enters at the last control.
    assert.equal(tab(true, null), 1);
    assert.equal(dom.focused(), "#join-link-close");
    // Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last.
    assert.equal(tab(false, dom.node("#join-link-close")), 1);
    assert.equal(dom.focused(), "#join-link-name");
    assert.equal(tab(true, dom.node("#join-link-name")), 1);
    assert.equal(dom.focused(), "#join-link-close");
    // Tab in the middle is left alone.
    assert.equal(tab(false, dom.node("#join-link-name")), 0);
  } finally { dom.uninstall(); }
});
