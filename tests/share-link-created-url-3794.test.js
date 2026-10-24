// #3794: creating an invite link never surfaced the new link's URL —
// the dialog kept showing a pre-existing guest (growth) link in the
// kit's "Your invite link" field, so a Member invite silently joined
// people as guests when the inviter copied the visible URL. The create
// flow did compute and auto-copy the right URL and showed it in the
// result section, but the growth kit stayed on screen beside it with a
// different URL under the same "your invite link" framing.
//
// Pin: while a create result is shown, the growth kit is hidden (the
// result owns the dialog's URL — the same ownership the form already
// had); when the result clears ("Create another", cancel, expiry), the
// kit comes back. Manage-links rows deliberately get no copy action:
// the server never exposes link tokens (server/share-links.mjs —
// "neither the invitation token nor its hash is exposed").
import test from "node:test";
import assert from "node:assert/strict";
import { installShareLinks } from "../src/share-links.js";

test("#3794: a shown create result hides the growth kit's stale URL; clearing the result restores it", async () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      contains() { return false; }, replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() {},
    });
    return nodes.get(selector);
  };
  const globals = { document: { querySelector: node }, window: { addEventListener() {} },
    location: { hostname: "localhost", origin: "http://localhost:52331" } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const member = { id: "owner", kind: "human", revision: 1, permissions: ["manage_members"] };
  const session = { member };
  const requests = [];
  const client = {
    session, ownsAccountSession: () => true, generation: 0, path: suffix => suffix,
    async request(path, options) {
      if (path === "/referrals") return { invite: { token: "growth-token-3794", status: "active" }, reward: null };
      assert.equal(path, "/share-links");
      if (options?.method === "POST") {
        requests.push(structuredClone(options.data));
        return { link: { id: "created-link", status: "active", access: options.data.access ?? "guest", expiresAt: options.data.expiresAt } };
      }
      return { links: [] };
    },
  };
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const ui = installShareLinks({ client, accountClient: {}, getState: () => ({ members: { owner: member }, room: { id: "room1", ownerId: "owner" } }), getSession: () => session, openRoom() {} });
    // The kit section exists in the real dialog chrome; the fake DOM
    // has no createElement, so seed the node the module will query.
    const kit = node("#growth-kit");
    node("#share-link-expiry").value = "24";
    node("#share-link-limit").value = "2";
    await node("#invite-people-button").handlers.click();
    // Before any create, the kit shows the pre-existing growth link.
    assert.match(node("#growth-invite-url").value, /growth-token-3794/);
    assert.equal(kit.hidden, false);
    // Create a MEMBER link.
    node("#share-link-access").value = "member";
    await node("#share-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(requests[0].access, "member");
    // The result shows the created link's URL...
    assert.equal(node("#share-link-result").hidden, false);
    assert.match(node("#share-link-url").value, new RegExp(requests[0].linkToken));
    // ...and it is the ONLY invite URL on screen: the kit is hidden.
    assert.equal(kit.hidden, true,
      "while the result is shown, the growth kit's different URL must not be visible");
    // Create another -> result clears -> the kit returns.
    await node("#share-link-another").handlers.click();
    assert.equal(node("#share-link-result").hidden, true);
    assert.equal(kit.hidden, false);
    ui.resetManagement();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
