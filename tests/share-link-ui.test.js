import test from "node:test";
import assert from "node:assert/strict";
import { installShareLinks, setShareLinkStatus, invitationFailureMessage, invitationManagementFailureMessage, reuseVisibleRoom } from "../src/share-links.js";

test("invitation status uses the shared form-status visibility contract", () => {
  const classes = new Set();
  const element = { textContent: "", classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } };
  for (const text of ["Joining room…", "Ask for a new link.", "Link copied.", "Select and copy the link above."]) {
    setShareLinkStatus(element, text);
    assert.equal(element.textContent, text);
    assert.equal(classes.has("visible"), true);
  }
  setShareLinkStatus(element, "");
  assert.equal(element.textContent, "");
  assert.equal(classes.has("visible"), false);
});

test("same-room invitation revalidates the visible Room session, not an older account identity", async () => {
  const session = { roomId: "commons", authMode: "room", member: { id: "owner" } };
  let refreshes = 0;
  const client = { session, generation: 3, async refresh() { refreshes++; } };
  const joined = await reuseVisibleRoom(client, "commons", session);
  assert.equal(joined.session, session);
  assert.equal(joined.roomMode, true);
  assert.equal(refreshes, 1);
  assert.equal(await reuseVisibleRoom(client, "elsewhere", session), null);
  assert.equal(await reuseVisibleRoom(client, "commons", { ...session }), null);
  assert.equal(refreshes, 1);
  client.refresh = async () => { client.generation++; };
  await assert.rejects(() => reuseVisibleRoom(client, "commons", session), /identity changed/);
});

test("visible-room revalidation failure does not produce a reusable join result", async () => {
  const session = { roomId: "commons", authMode: "account" };
  const client = { session, generation: 0, async refresh() { throw new TypeError("Failed to fetch"); } };
  await assert.rejects(() => reuseVisibleRoom(client, "commons", session), /Failed to fetch/);
  client.refresh = async () => { client.session = null; };
  await assert.rejects(() => reuseVisibleRoom(client, "commons", session), /identity changed/);
});

test("invitation transport errors give an honest, actionable same-request retry message", () => {
  for (const error of [new DOMException("signal is aborted without reason", "AbortError"), new TypeError("Failed to fetch")]) {
    assert.match(invitationFailureMessage(error), /could not confirm the result/);
    assert.match(invitationFailureMessage(error), /same request/);
    assert.doesNotMatch(invitationFailureMessage(error), /signal is aborted/);
  }
  assert.equal(invitationFailureMessage(new Error("Ask for a new link.")), "Ask for a new link.");
});

test("invitation management recovery distinguishes listing, creation and cancellation", () => {
  const error = new TypeError("Failed to fetch");
  assert.match(invitationManagementFailureMessage(error, "list"), /Close and reopen/);
  assert.match(invitationManagementFailureMessage(error, "create"), /same request/);
  assert.match(invitationManagementFailureMessage(error, "cancel"), /same link again/);
  assert.equal(invitationManagementFailureMessage(new Error("Membership is inactive."), "create"), "Membership is inactive.");
});

test("invitation UI retries the same uncertain creation and preserves confirmed success when the list fails", async () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {},
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() { focused = selector; },
    });
    return nodes.get(selector);
  };
  let focused = null, createAttempts = 0, lists = 0;
  const requests = [];
  const globals = { document: { querySelector: node }, window: { addEventListener() {} },
    location: { hostname: "localhost", origin: "http://localhost:52331" } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const member = { id: "owner", kind: "human", revision: 1, permissions: ["manage_members"] };
  const client = {
    generation: 0, path: suffix => suffix,
    async request(path, options) {
      assert.equal(path, "/share-links");
      if (options?.method === "POST") {
        requests.push(structuredClone(options.data));
        if (++createAttempts === 1) throw new TypeError("Failed to fetch");
        return { link: { id: "created-link", status: "active" } };
      }
      if (++lists > 1) throw new TypeError("Failed to fetch");
      return { links: [] };
    },
  };
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    installShareLinks({ client, accountClient: {}, getState: () => ({ members: { owner: member } }), getSession: () => ({ member }), openRoom() {} });
    node("#share-link-expiry").value = "24";
    node("#share-link-limit").value = "2";
    await node("#invite-people-button").handlers.click();
    await node("#share-link-form").handlers.submit({ preventDefault() {} });
    assert.match(node("#share-link-status").textContent, /could not confirm the result/);
    assert.equal(node("#share-link-create").disabled, false);
    await node("#share-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(createAttempts, 2);
    assert.deepEqual(requests[1], requests[0], "retry preserves token, request ID, expiry, scope and membership revision");
    assert.equal(node("#share-link-status").textContent, "Link ready.");
    assert.match(node("#share-management-status").textContent, /reload invitation links/);
    assert.equal(node("#share-link-result").hidden, false);
    assert.equal(node("#share-link-url").value, `http://localhost:52331/#join/${requests[0].linkToken}`);
    assert.equal(node("#share-link-create").disabled, false);
    assert.equal(focused, "#share-link-copy");
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("failed guest join retains its request, restores retry focus and keeps pending controls locked", async () => {
  const nodes = new Map();
  let focused = null, rejectJoin, attempts = 0, opened = null;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {},
      classList: { toggle() {} }, addEventListener(type, handler) { this.handlers[type] = handler; },
      replaceChildren() {}, reset() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() { focused = selector; },
      querySelectorAll() { return [node("#join-link-name"), node("#join-link-submit"), node("#join-link-close")]; },
    });
    return nodes.get(selector);
  };
  const globals = { document: { querySelector: node }, window: { addEventListener() {} },
    location: { hostname: "localhost", origin: "http://localhost:52331" } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [];
  const accountClient = {
    session: {},
    async prepareShareLink() { return { session: this.session, preview: { room: { id: "commons", title: "Synthetic room" }, access: "Conversation only.", link: { expiresAt: Date.now() + 3600000, remainingJoins: 2 } } }; },
    async joinShareLink(request) {
      calls.push(structuredClone(request));
      if (++attempts === 1) return new Promise((resolve, reject) => { rejectJoin = reject; });
      return { roomId: "commons", session: { member: { id: "same-guest" } } };
    },
  };
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom(roomId, roomMode, session) { opened = { roomId, roomMode, session }; } });
    await ui.open({ token: "s".repeat(43) });
    node("#join-link-name").value = "Retry guest";
    const pending = node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(node("#join-link-submit").disabled, true);
    assert.equal(node("#join-link-close").disabled, true);
    assert.equal(node("#join-link-name").disabled, true);
    let escapePrevented = false;
    node("#join-link-dialog").handlers.cancel({ preventDefault() { escapePrevented = true; } });
    assert.equal(escapePrevented, true);
    rejectJoin(new TypeError("Synthetic lost response"));
    await pending;
    assert.equal(focused, "#join-link-submit");
    assert.equal(node("#join-link-submit").disabled, false);
    assert.equal(node("#join-link-close").disabled, false);
    assert.equal(node("#join-link-name").disabled, false);
    assert.equal(node("#join-link-name").value, "Retry guest");
    assert.equal(node("#join-link-dialog").open, true);
    assert.match(node("#join-link-status").textContent, /could not confirm the result/);
    await node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(opened.session.member.id, "same-guest");
    assert.equal(node("#join-link-dialog").open, false);
    assert.equal(focused, "#message-input");
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
