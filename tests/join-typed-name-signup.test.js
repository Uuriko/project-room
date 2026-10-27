// User test 2026-10-19 (#3): a friend opened an invite link signed out, typed
// "Ben Test" in "Your name", then created an account from the same dialog. The
// dialog re-opened after sign-in (resumeSignedIn -> open(afterSignIn)), reset
// the form, and applyAccountDefaults refilled the empty field from the email
// local part ("johns.tab+r423b") because a new email account has no profile
// name yet. The typed name was silently replaced.
import test from "node:test";
import assert from "node:assert/strict";
import { installShareLinks } from "../src/share-links.js";

const fakeDom = () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { toggle() {} }, addEventListener(type, handler) { this.handlers[type] = handler; },
      contains() { return false; }, replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      // A real form.reset() clears its inputs; the join form holds #join-link-name.
      reset() { if (selector === "#join-link-form") node("#join-link-name").value = ""; },
      focus() {}, after() {},
      querySelectorAll() { return [node("#join-link-name"), node("#join-link-submit"), node("#join-link-close")]; },
    });
    return nodes.get(selector);
  };
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
  const sessionStorage = store(), localStorage = store();
  const globals = { document: { querySelector: node, createElement: () => node(`#created-${nodes.size}`) }, window: { addEventListener() {}, sessionStorage },
    location: { hostname: "localhost", origin: "http://localhost:52331", hash: "", pathname: "/" }, localStorage, sessionStorage };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  return {
    node,
    install() { for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); },
    uninstall() { for (const [key, d] of previous) { if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; } },
  };
};

const preview = { room: { id: "commons", title: "Ana's room" }, access: "Conversation only.", link: { expiresAt: Date.now() + 3600000, remainingJoins: 2, status: "active", access: "guest" } };

function accountClientFor({ profileName = null } = {}) {
  return {
    session: { authenticated: false },
    async restore() { return this.session; },
    async prepareShareLink() { return { session: this.session, preview }; },
    currentSession() { if (!this.session.authenticated) throw new Error("signed out"); return this.session; },
    async request(path) {
      if (path === "/api/auth/methods") return { methods: [{ type: "password", email: "johns.tab+r423b@mail.tab.bot" }], emailVerification: { status: "verified" } };
      if (path === "/api/account/profile") return { displayName: profileName };
      throw new Error(`unexpected ${path}`);
    },
  };
}

test("a name typed before creating an account survives the return to the join form", async () => {
  const dom = fakeDom(), accountClient = accountClientFor();
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, async openRoom() {} });
    await ui.open({ token: "s".repeat(43) });
    dom.node("#join-link-name").value = "Ben Test";
    accountClient.session = { authenticated: true, account: { id: "acct-ben" } }; // account created in the dialog
    assert.equal(await ui.resumeSignedIn(), true);
    assert.equal(dom.node("#join-link-name").value, "Ben Test", "the typed name is not replaced by the email local part");
  } finally { dom.uninstall(); }
});

test("with nothing typed, the account's own name (then the email) still fills in", async () => {
  for (const [profileName, expected] of [["Ben Account", "Ben Account"], [null, "johns.tab+r423b"]]) {
    const dom = fakeDom(), accountClient = accountClientFor({ profileName });
    dom.install();
    try {
      const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, async openRoom() {} });
      await ui.open({ token: "s".repeat(43) });
      accountClient.session = { authenticated: true, account: { id: "acct-ben" } };
      await ui.resumeSignedIn();
      assert.equal(dom.node("#join-link-name").value, expected);
    } finally { dom.uninstall(); }
  }
});

test("a fresh invitation (not a sign-in return) never carries an old typed name", async () => {
  const dom = fakeDom(), accountClient = accountClientFor({ profileName: "Ben Account" });
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, async openRoom() {} });
    await ui.open({ token: "s".repeat(43) });
    dom.node("#join-link-name").value = "Typed for link one";
    accountClient.session = { authenticated: true, account: { id: "acct-ben" } };
    await ui.open({ token: "t".repeat(43) });
    assert.equal(dom.node("#join-link-name").value, "Ben Account");
  } finally { dom.uninstall(); }
});
