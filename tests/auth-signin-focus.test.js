// Focus restoration for the human sign-in UI: render() rebuilds the panel
// from HTML, which destroys the focused control. Keyboard users must not be
// stranded on <body> after a re-render (busy toggle, error, manual-code
// toggle). The agent sign-in UI (src/agent-signin-ui.js) already keeps focus
// across renders; this file pins the same contract for the human UI.
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

function makeDocument() {
  const doc = { activeElement: null, body: { tagName: "BODY" } };
  doc.activeElement = doc.body;
  return doc;
}

let specSeq = 0;
function makeElement(spec, doc) {
  const el = {
    __specId: spec.id ?? `el-${specSeq++}`,
    tag: spec.tag,
    attrs: { ...(spec.attrs ?? {}) },
    disabled: false,
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    closest() { return null; },
    getClientRects() { return [{}]; },
    classList: { toggle() {}, add() {}, remove() {} },
    focus() { doc.activeElement = el; },
  };
  Object.defineProperty(el, "name", { get() { return this.attrs.name ?? ""; } });
  return el;
}

// Minimal container double: innerHTML replacement rebuilds the control list
// (like the real render), and destroying the focused node drops focus to
// <body>, exactly as browsers do when a focused node is removed.
function makeContainer(doc, specsFor) {
  let elements = [];
  const extraContained = new Set();
  const listeners = {};
  const status = { textContent: "", classList: { toggle() {} } };
  const container = {
    listeners,
    status,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); },
    set innerHTML(_html) {
      const hadFocus = elements.includes(doc.activeElement);
      elements = specsFor().map(spec => makeElement(spec, doc));
      if (hadFocus) doc.activeElement = doc.body;
    },
    get innerHTML() { return "<panel/>"; },
    querySelector(selector) {
      if (selector === "[data-signin-status]") return status;
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      if (selector === "input, button") return elements.filter(el => el.tag === "input" || el.tag === "button");
      const nameMatch = selector.match(/^\[name="([^"]+)"\]$/);
      if (nameMatch) return elements.filter(el => el.getAttribute("name") === nameMatch[1]);
      const attrMatch = selector.match(/^\[([a-z-]+)\]$/);
      if (attrMatch) return elements.filter(el => el.hasAttribute(attrMatch[1]));
      return [];
    },
    contains(el) { return elements.includes(el) || extraContained.has(el); },
    setAttribute() {},
    __elements() { return elements; },
    __contain(el) { extraContained.add(el); },
  };
  return container;
}

const attrFor = sel => (sel.match(/\[data-([a-z-]+)\]/) ?? [])[1];
const clickOnDataset = (kind, dataset = {}) => ({ target: { closest: sel => attrFor(sel) === kind ? { dataset } : null } });
const submitForm = (kind, values = {}) => {
  const form = {
    dataset: { signinForm: kind },
    querySelectorAll: () => Object.entries(values).map(([name, value]) => ({ name, value })),
  };
  return { preventDefault() {}, __form: form, target: { closest: sel => sel === "[data-signin-form]" ? form : null } };
};

function stubClient(routes = {}) {
  const calls = [];
  return {
    calls,
    generation: 0,
    session: { authenticated: false, csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1 },
    currentSession() { return this.session; },
    owns(generation, session) { return this.generation === generation && this.session === session; },
    invalidate(generation, session) { if (!this.owns(generation, session)) return false; this.generation++; this.session = null; return true; },
    async restore() { return { authenticated: true, account: { id: "restored" } }; },
    async request(path, { data } = {}) {
      calls.push({ path, data });
      const reply = routes[path];
      const resolved = typeof reply === "function" ? reply(data) : reply;
      if (resolved?.throw) throw Object.assign(new Error(resolved.throw.message), { code: resolved.throw.code });
      return resolved;
    }
  };
}

const PASSWORD_SPECS = () => [
  { id: "email", tag: "input", attrs: { name: "email", type: "email" } },
  { id: "password", tag: "input", attrs: { name: "password", type: "password" } },
  { id: "visibility", tag: "button", attrs: { "data-password-visibility": "" } },
  { id: "submit", tag: "button", attrs: { type: "submit" } },
];
const MAGIC_SENT_HIDDEN_SPECS = () => [
  { id: "manual-toggle", tag: "button", attrs: { "data-magic-manual-code": "" } },
  { id: "restart", tag: "button", attrs: { "data-magic-restart": "" } },
];
const MAGIC_SENT_SHOWN_SPECS = () => [
  { id: "code", tag: "input", attrs: { name: "code" } },
  { id: "code-submit", tag: "button", attrs: { type: "submit" } },
  { id: "manual-toggle", tag: "button", attrs: { "data-magic-manual-code": "" } },
  { id: "restart", tag: "button", attrs: { "data-magic-restart": "" } },
];

function mountSignin(doc, routes = {}, specsFor = PASSWORD_SPECS) {
  const client = stubClient(routes);
  const ui = createAuthSigninUI({
    accountClient: client,
    ensureAccountSession: async () => {},
    onSignedIn: async () => {},
  });
  const container = makeContainer(doc, specsFor);
  globalThis.document = doc;
  ui.mount(container);
  return { client, ui, container };
}

const byId = (container, id) => container.__elements().find(el => el.__specId === id);

test("failed sign-in returns focus to the submit button, not <body>", async () => {
  const doc = makeDocument();
  const { container } = mountSignin(doc, { "/api/auth/password/login": () => ({ throw: { message: "boom" } }) });
  const submit = byId(container, "submit");
  submit.focus();
  assert.equal(doc.activeElement, submit);

  const event = submitForm("password", { email: "k@example.invalid", password: "synthetic-password" });
  container.__contain(event.__form);
  await container.listeners.submit[0](event);

  const refocused = byId(container, "submit");
  assert.ok(container.__elements().includes(doc.activeElement),
    `focus left the panel after a failed sign-in (activeElement is ${doc.activeElement?.tagName ?? "unknown"})`);
  assert.equal(doc.activeElement, refocused, "focus should return to the submit button the user activated");
});

test("revealing the manual magic code moves focus into the new code field", async () => {
  const doc = makeDocument();
  let specs = MAGIC_SENT_HIDDEN_SPECS;
  const { container } = mountSignin(doc, {}, () => specs());
  const toggle = byId(container, "manual-toggle");
  toggle.focus();

  specs = MAGIC_SENT_SHOWN_SPECS; // the toggle re-renders with the code field present
  await container.listeners.click[0](clickOnDataset("magic-manual-code"));

  assert.equal(doc.activeElement, byId(container, "code"), "focus should follow the newly revealed code input");
});

test("hiding the manual magic code returns focus to the toggle", async () => {
  const doc = makeDocument();
  let specs = MAGIC_SENT_SHOWN_SPECS;
  const { container } = mountSignin(doc, {}, () => specs());
  const toggle = byId(container, "manual-toggle");
  toggle.focus();

  specs = MAGIC_SENT_HIDDEN_SPECS;
  await container.listeners.click[0](clickOnDataset("magic-manual-code"));

  assert.equal(doc.activeElement, byId(container, "manual-toggle"), "focus should return to the toggle that hid the field");
});

test("busy render does not yank focus the user deliberately moved elsewhere", async () => {
  const doc = makeDocument();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { container } = mountSignin(doc, { "/api/auth/password/login": () => gate });
  const submit = byId(container, "submit");
  submit.focus();

  const event = submitForm("password", { email: "k@example.invalid", password: "synthetic-password" });
  container.__contain(event.__form);
  const pending = container.listeners.submit[0](event);
  // While the request is in flight the user tabs away to something outside the panel.
  const elsewhere = { tagName: "DIV", focus() { doc.activeElement = elsewhere; } };
  elsewhere.focus();
  release({ authenticated: true, account: { id: "a" } });
  await pending;

  assert.equal(doc.activeElement, elsewhere, "focus the user moved elsewhere must not be pulled back");
});

test("re-render with no matching control leaves focus on <body>", async () => {
  const doc = makeDocument();
  let specs = PASSWORD_SPECS;
  const { container, ui } = mountSignin(doc, {}, () => specs());
  const email = byId(container, "email");
  email.focus();

  // The terms view has no email input; the old control is gone for good.
  specs = () => [{ id: "agree", tag: "button", attrs: { type: "submit" } }];
  ui.requireTerms({ terms: { required: true, version: "3" } });

  assert.equal(doc.activeElement, doc.body, "focus should stay on body when the focused control no longer exists");
});
