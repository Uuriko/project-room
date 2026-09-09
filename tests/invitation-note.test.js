import test from "node:test";
import assert from "node:assert/strict";
import { installShareLinks } from "../src/share-links.js";

function setup(t) {
  const nodes = new Map(), copies = [], requests = [];
  let doc;
  const makeNode = () => ({ value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {},
    classList: { toggle() {} }, addEventListener(name, fn) { this.handlers[name] = fn; },
    contains() { return false; }, replaceChildren() {}, append() {}, setAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; }, focus() { doc.activeElement = this; }, select() {} });
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); };
  doc = { querySelector: node, createElement: makeNode, body: {}, activeElement: null };
  const member = { id: "owner", kind: "human", active: true, revision: 1, permissions: ["manage_members"] };
  let session = { roomId: "commons", member }, authorized = true, responder;
  const client = { session, generation: 1, ownsAccountSession: () => authorized, path: suffix => suffix,
    async request(path, options) {
      requests.push({ path, options });
      if (responder) return responder(path, options);
      return options?.method === "POST" ? { link: { id: `link-${requests.length}`, status: "active", expiresAt: options.data.expiresAt } } : { links: [] };
    } };
  const globals = { document: doc, window: { addEventListener() {} }, location: { origin: "http://localhost", hostname: "localhost" },
    navigator: { clipboard: { async writeText(value) { copies.push(value); } } } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const ui = installShareLinks({ client, accountClient: {}, getState: () => ({ members: { owner: member } }), getSession: () => session, openRoom() {} });
  t.after(() => {
    ui.resetManagement();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  node("#share-link-expiry").value = "24"; node("#share-link-limit").value = "10";
  return { node, ui, member, client, copies, requests,
    setSession(value) { session = value; }, revoke() { authorized = false; }, setResponder(value) { responder = value; },
    open: () => node("#invite-people-button").handlers.click(),
    create: () => node("#share-link-form").handlers.submit({ preventDefault() {} }),
    note(value) { node("#share-note").open = true; node("#share-note-text").value = value; node("#share-note-text").handlers.input(); },
  };
}

for (const boundary of ["generation", "visible session", "client session", "account ownership", "member revision", "permissions", "inactive", "agent"]) {
  test(`invitation note retires before copying after ${boundary} changes`, async t => {
    const f = setup(t); await f.open(); await f.create(); f.note("Private draft");
    assert.ok(f.node("#share-note-preview").value.includes("Private draft"));
    if (boundary === "generation") f.client.generation++;
    if (boundary === "visible session") f.setSession({ ...f.client.session });
    if (boundary === "client session") f.client.session = { ...f.client.session };
    if (boundary === "account ownership") f.revoke();
    if (boundary === "member revision") f.member.revision++;
    if (boundary === "permissions") f.member.permissions = [];
    if (boundary === "inactive") f.member.active = false;
    if (boundary === "agent") f.member.kind = "agent";
    await f.node("#share-note-copy").handlers.click();
    assert.deepEqual(f.copies, []);
    for (const field of ["share-link-url", "share-note-text", "share-note-preview"]) assert.equal(f.node("#" + field).value, "");
    assert.equal(f.node("#share-link-result").hidden, true);
  });
}

for (const denial of [{ status: 401 }, { status: 403 }, { status: 422, code: "session_binding_required" }, { status: 422, code: "invalid_session_binding" }]) {
  test(`management denial ${denial.status}/${denial.code ?? "auth"} defeats an older successful creation`, async t => {
    const f = setup(t), listing = Promise.withResolvers(), creation = Promise.withResolvers();
    f.setResponder((path, options) => options?.method === "POST" ? creation.promise : listing.promise);
    const opening = f.open(), creating = f.create();
    listing.reject(Object.assign(new Error("Synthetic access change"), denial));
    await opening;
    assert.equal(f.node("#share-link-dialog").open, false);
    creation.resolve({ link: { id: "old-success", status: "active", expiresAt: Date.now() + 3600000 } });
    await creating;
    assert.equal(f.node("#share-link-result").hidden, true);
    assert.equal(f.node("#share-link-url").value, "");
  });
}

for (const outcome of ["expired response", "member revision", "inactive duplicate"]) {
  test(`confirmed creation with ${outcome} permits a fresh request without changing settings`, async t => {
    const f = setup(t), creation = Promise.withResolvers();
    let count = 0;
    f.setResponder((path, options) => {
      if (options?.method !== "POST") return { links: [] };
      return ++count === 1 ? creation.promise : { link: { id: "new-link", status: "active", expiresAt: options.data.expiresAt } };
    });
    await f.open(); const creating = f.create();
    if (outcome === "member revision") f.member.revision++;
    creation.resolve({ link: { id: "old-link", status: outcome === "inactive duplicate" ? "expired" : "active",
      expiresAt: Date.now() + (outcome === "expired response" ? -100 : 3600000) } });
    await creating;
    assert.equal(f.node("#share-link-result").hidden, true);
    await f.create();
    const writes = f.requests.filter(request => request.options?.method === "POST");
    assert.notEqual(writes[0].options.data.requestId, writes[1].options.data.requestId);
    assert.notEqual(writes[0].options.data.linkToken, writes[1].options.data.linkToken);
    assert.equal(writes[1].options.data.expectedMemberRevision, f.member.revision);
    assert.equal(f.node("#share-link-result").hidden, false);
  });
}

for (const status of ["full", "cancelled", "expired", "authority_changed"]) {
  test(`known ${status} listing retires its displayed invitation`, async t => {
    const f = setup(t);
    f.setResponder((path, options) => options?.method === "POST"
      ? { link: { id: "link", status: "active", expiresAt: options.data.expiresAt } }
      : { links: [{ id: "link", status, joins: 0, maxJoins: 1, expiresAt: Date.now() + 3600000 }] });
    await f.open(); await f.create();
    await f.node("#share-link-copy").handlers.click();
    assert.equal(f.node("#share-link-result").hidden, true);
    assert.deepEqual(f.copies, []);
  });
}
