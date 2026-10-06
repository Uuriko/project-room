// plan-squads UI: the pure squad-list renderer. Guards the read-parity
// contract at the cheapest boundary — squad fields render, member display
// names and goals are HTML-escaped (XSS regression), and the empty state
// teaches the @squad/<name> handle. No DOM: installSquadsPanel wires this
// HTML into #squads-list.
import test from "node:test";
import assert from "node:assert/strict";
import { squadsHtml } from "../src/squads-ui.js";

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
});
