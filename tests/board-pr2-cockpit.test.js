// BOARD-PR2-COCKPIT: sweep lane-10 Mediums F7/F8 client halves (issues
// #3890/#3891), pinned failing-first. F8: the cockpit rendered every
// POST action as an Approve/Deny decide button — including the spend
// item's body-less "adjust" pointer, which POSTs an empty body to the
// spend-allowance endpoint and can only fail, mislabeled as a denial.
// The in-room needs-attention card owns the correct rule: a POST action
// is a decide only when it carries a body; otherwise it renders its
// hint. F7 (client half): the cockpit's KIND_LABEL lacks board_review,
// so board-review cards show the raw kind string (the server half —
// decisionFacts age/consequence — is specified in PR2.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerCockpit } from "../src/owner-cockpit.js";

function cockpitWith(doc) {
  const boxes = {};
  const box = () => ({ textContent: "", innerHTML: "", querySelectorAll: () => [] });
  const section = { hidden: true, querySelector(selector) { return boxes[selector] ??= box(); } };
  const cockpit = createOwnerCockpit({ accountClient: { ownerOverview: async () => doc }, section, decide: async () => {} });
  return { cockpit, decisionsHtml: () => boxes["#cockpit-decisions"].innerHTML };
}
const docWith = items => ({
  decisions: { waiting: items.length, oldestAgeMs: 0, overdue: 0, total: items.length, items },
  exceptions: { total: 0, items: [] }, rooms: {}, roomErrors: [],
});

// The spend item exactly as server/owner-attention.mjs emits it.
const spendItem = {
  kind: "spend", id: "spend-allowance", roomId: "room-1", roomName: "Room One",
  title: "Spend allowance running low", ageMs: null,
  consequence: "At zero headroom, new session starts are refused",
  actions: [{ action: "adjust", method: "POST", path: "/api/rooms/room-1/spend-allowance",
    hint: "Send { allowanceCents, periodDays? } to raise the allowance" }],
};

test("(F8) the spend item's adjust pointer is not rendered as a Deny decide button", async () => {
  const { cockpit, decisionsHtml } = cockpitWith(docWith([spendItem]));
  await cockpit.refresh();
  const html = decisionsHtml();
  assert.doesNotMatch(html, /data-cockpit-decide/, "a body-less POST is a pointer, not a decide");
  assert.doesNotMatch(html, />Deny</, "nothing about the spend pointer is a denial");
  assert.match(html, /Send \{ allowanceCents, periodDays\? \} to raise the allowance/,
    "the hint renders instead, as the in-room card renders it");
});

test("(F8) real decide actions (POST with a body) still render Approve/Deny buttons", async () => {
  const request = {
    kind: "access_request", id: "req-1", roomId: "room-1", roomName: "Room One",
    title: "Join request", ageMs: 60_000, consequence: null,
    actions: [
      { action: "approve", method: "POST", path: "/api/rooms/room-1/access-requests/req-1/decide", body: { decision: "approve", permissions: [], note: null } },
      { action: "deny", method: "POST", path: "/api/rooms/room-1/access-requests/req-1/decide", body: { decision: "deny", permissions: [], note: null } },
    ],
  };
  const { cockpit, decisionsHtml } = cockpitWith(docWith([request]));
  await cockpit.refresh();
  const html = decisionsHtml();
  assert.match(html, /data-cockpit-decide="approve"/);
  assert.match(html, /data-cockpit-decide="deny"/);
  assert.match(html, />Approve</);
  assert.match(html, />Deny</);
});

test("(F7) a board_review item renders its label, not the raw kind string", async () => {
  const review = {
    kind: "board_review", id: "wc_1", roomId: "room-1", roomName: "Room One",
    title: "Review: Delivered thing", ageMs: 3_600_000, consequence: null,
    actions: [{ action: "review", method: "GET", path: "/api/rooms/room-1/work-claims/wc_1" }],
  };
  const { cockpit, decisionsHtml } = cockpitWith(docWith([review]));
  await cockpit.refresh();
  const html = decisionsHtml();
  assert.match(html, /<strong>Board review<\/strong>/, "the label matches the in-room needs-attention card");
  assert.doesNotMatch(html, /<strong>board_review<\/strong>/);
});
