// plan-squads UI: the pure squad-list renderer. Guards the read-parity
// contract at the cheapest boundary — squad fields render, member display
// names and goals are HTML-escaped (XSS regression), and the empty state
// teaches the @squad/<name> handle. No DOM: installSquadsPanel wires this
// HTML into #squads-list.
import test from "node:test";
import assert from "node:assert/strict";
import { installSquadsPanel, squadsHtml } from "../src/squads-ui.js";

const squad = (over = {}) => ({
  id: "sq_abc", name: "crew", goal: "ship it", members: ["owner", "guest"],
  channel: "m1", owner: "owner", state: "active", ...over
});
const members = { owner: { displayName: "Owen" }, guest: { displayName: "G <u>uest</u>" } };

test("squadsHtml renders one card per squad with goal, roster, and channel", () => {
  const html = squadsHtml([squad()], members);
  assert.ok(html.includes("@squad/crew"), "the fan-out handle is visible");
  assert.ok(html.includes("ship it"));
  assert.ok(html.includes("Owen"));
  assert.ok(html.includes("open thread"), "the channel links to the thread");
  assert.ok(html.includes("owner"), "the owner is marked");
});

test("squadsHtml escapes member display names and goals", () => {
  const html = squadsHtml([squad({ goal: "<script>alert(1)</script>" })], members);
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(html.includes("<u>"), false, "member display-name markup is escaped");
  assert.ok(html.includes("G &lt;u&gt;uest&lt;/u&gt;"));
});

test("squadsHtml marks disbanded squads and teaches the handle when empty", () => {
  const html = squadsHtml([squad({ state: "disbanded" })], members);
  assert.ok(html.includes("disbanded"));
  const empty = squadsHtml([], members);
  assert.ok(empty.includes("@squad/&lt;name&gt;"), "empty state teaches the mention handle");
  assert.ok(empty.includes("create squad"), "empty state offers the create action");
});

test("installSquadsPanel refetches on a later sync once the cached load is stale", async () => {
  const realDocument = globalThis.document;
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const root = {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    addEventListener: () => {},
    replaceChildren() { this.innerHTML = ""; },
  };
  globalThis.document = {
    activeElement: null,
    querySelector: selector => (selector === "#squads-list" ? root : null),
  };
  let serverSquads = [squad()];
  let calls = 0;
  const client = {
    generation: 1,
    path: suffix => `/api/rooms/room1${suffix}`,
    async request() { calls++; return { squads: serverSquads }; },
  };
  try {
    const panel = installSquadsPanel({
      client,
      getState: () => ({ members }),
      getSession: () => ({ roomId: "room1", member: { id: "owner" } }),
    });
    await panel.sync();
    assert.equal(calls, 1, "the first sync loads the squads");
    assert.ok(root.innerHTML.includes("@squad/crew"), "the first snapshot is painted");

    // Another member creates a squad; an immediate re-sync (e.g. a render)
    // must not hammer the endpoint, so it still serves the fresh cache.
    serverSquads = [squad(), squad({ id: "sq_def", name: "rescue" })];
    await panel.sync();
    assert.equal(calls, 1, "a sync inside the freshness window reuses the cache");

    // Once the cached load is stale, a later sync refetches and the
    // externally created squad appears without any local mutation.
    now += 31_000;
    await panel.sync();
    assert.equal(calls, 2, "a sync after the freshness window refetches");
    assert.ok(root.innerHTML.includes("@squad/rescue"), "the external squad change is painted");
  } finally {
    Date.now = realNow;
    if (realDocument === undefined) delete globalThis.document; else globalThis.document = realDocument;
  }
});

test("squadsHtml shows the disband button to the owner only", () => {
  const ownerView = squadsHtml([squad()], members, "owner");
  assert.ok(ownerView.includes('data-squad-action="disband"'), "owner sees disband");
  const guestView = squadsHtml([squad()], members, "guest");
  assert.ok(!guestView.includes('data-squad-action="disband"'), "non-owner sees no disband");
  const gone = squadsHtml([squad({ state: "disbanded" })], members, "owner");
  assert.ok(!gone.includes('data-squad-action="disband"'), "disbanded squads show no disband");
});
