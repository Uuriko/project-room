// B4-BOARD-BATCH PR-D: cockpit/deep-link sweep Mediums.
// #3890: decisionFacts had no board_review branch (board-native claims
// are not in workItems, so their cockpit facts were null across age,
// consequence and sort) and spend items returned createdAtMs: null.
// #3891: the cockpit rendered spend's body-less "adjust" POST as a
// Deny button POSTing an empty body to spend-allowance.
// #3892: revealClaimRecord (the deep-link path) discarded the board
// reveal's boolean; the click path notices on failure, this one must
// too. (#3921 covered deep-linked messages, not this seam — verified
// against current source: the swallow was still present.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decisionFacts } from "../server/owner-overview.mjs";
import { createOwnerCockpit } from "../src/owner-cockpit.js";

const T0 = Date.parse("2026-10-16T10:00:00Z");
const DAY = 24 * 3600 * 1000;
const facts = (item, extra = {}) => decisionFacts(item, {
  requestsById: new Map(), workItems: {}, budgetsByWorkItem: new Map(),
  claimsById: new Map(), spendSinceMs: null, ...extra,
});

test("#3890: a board_review item takes its age from the claim's delivery and carries a consequence", () => {
  const claim = { id: "wc_1", delivery: { deliveredAt: new Date(T0).toISOString() },
    updatedAt: new Date(T0 + DAY).toISOString(), claimedAt: new Date(T0 - DAY).toISOString() };
  const out = facts({ kind: "board_review", id: "wc_1" }, { claimsById: new Map([["wc_1", claim]]) });
  assert.equal(out.createdAtMs, T0, "waiting since the delivery landed, not the later touch");
  assert.match(out.consequence, /stays unverified/);
  assert.equal(out.consequenceAtMs, null, "no deadline constant governs a board review — never overdue");
});

test("#3890: board_review fallbacks — no delivery yet reads updatedAt, then claimedAt; unknown claim stays fact-less", () => {
  const claim = { id: "wc_2", delivery: null, updatedAt: new Date(T0 + DAY).toISOString(),
    claimedAt: new Date(T0).toISOString() };
  assert.equal(facts({ kind: "board_review", id: "wc_2" }, { claimsById: new Map([["wc_2", claim]]) }).createdAtMs,
    T0 + DAY);
  const claim2 = { id: "wc_3", delivery: null, updatedAt: null, claimedAt: new Date(T0).toISOString() };
  assert.equal(facts({ kind: "board_review", id: "wc_3" }, { claimsById: new Map([["wc_3", claim2]]) }).createdAtMs, T0);
  assert.equal(facts({ kind: "board_review", id: "wc_missing" }).createdAtMs, null,
    "a claim the registry no longer holds keeps null facts rather than borrowing a work item's");
});

test("#3890: a spend item is dated from its period start instead of null", () => {
  const out = facts({ kind: "spend", id: "spend-allowance" }, { spendSinceMs: T0 });
  assert.equal(out.createdAtMs, T0);
  assert.match(out.consequence, /zero headroom/);
  assert.equal(facts({ kind: "spend", id: "spend-allowance" }).createdAtMs, null,
    "no period read -> still null, never fabricated");
});

// --- cockpit client (#3890 label, #3891 adjust) ---

function cockpitSection() {
  const boxes = {
    "#cockpit-summary": { textContent: "" },
    "#cockpit-decisions": { innerHTML: "", querySelectorAll: () => [] },
    "#cockpit-exceptions": { innerHTML: "" },
    "#cockpit-room-stubs": { innerHTML: "" },
  };
  return { section: { hidden: true, querySelector: selector => boxes[selector] }, boxes };
}

async function renderDoc(items) {
  const { section, boxes } = cockpitSection();
  const doc = { decisions: { waiting: items.length, oldestAgeMs: 0, overdue: 0, total: items.length, items },
    exceptions: { total: 0, items: [] }, rooms: { label: null }, roomErrors: [] };
  const cockpit = createOwnerCockpit({ accountClient: { ownerOverview: async () => doc },
    section, decide: async () => {} });
  await cockpit.refresh();
  return boxes["#cockpit-decisions"].innerHTML;
}

test("#3891: spend's adjust renders as its hint, never as a Deny button posting an empty body", async () => {
  const html = await renderDoc([{ kind: "spend", id: "spend-allowance", title: "Spend allowance running low",
    roomId: "commons", roomName: "Commons", ageMs: 3600000, consequence: "At zero headroom, new session starts are refused",
    actions: [{ action: "adjust", method: "POST", path: "/api/rooms/commons/spend-allowance",
      hint: "Send { allowanceCents, periodDays? } to raise the allowance" }] }]);
  assert.doesNotMatch(html, /data-cockpit-decide/, "no decide button is rendered for a body-less POST");
  assert.doesNotMatch(html, />Deny</, "…and certainly not one labelled Deny");
  assert.match(html, /raise the allowance/, "the action's hint is shown instead, like the in-room card");
  assert.match(html, /waiting 1h/, "the item's age renders (the #3890 client half)");
});

test("#3891: real decide actions (POST with a body) still render Approve/Deny buttons", async () => {
  const html = await renderDoc([{ kind: "access_request", id: "ar-1", title: "Join request",
    roomId: "commons", ageMs: 0, consequence: null,
    actions: [
      { action: "approve", method: "POST", path: "/x", body: { decision: "approve" } },
      { action: "deny", method: "POST", path: "/x", body: { decision: "deny" } },
    ] }]);
  assert.match(html, /data-cockpit-decide="approve"[^>]*>Approve</);
  assert.match(html, /data-cockpit-decide="deny"[^>]*>Deny</);
});

test("#3890: the cockpit labels board_review items 'Board review', not the raw kind", async () => {
  const html = await renderDoc([{ kind: "board_review", id: "wc_1", title: "Review: Ship it",
    roomId: "commons", ageMs: 2 * DAY, consequence: "The delivered work stays unverified until this review is completed",
    actions: [{ action: "review", method: "GET", path: "/api/rooms/commons/bounties" }] }]);
  assert.match(html, /<strong>Board review<\/strong>/);
  assert.doesNotMatch(html, /<strong>board_review<\/strong>/);
  assert.match(html, /waiting 2d/, "the board review's age renders from its new facts");
});

test("#3892: revealClaimRecord notices when the board cannot show the claim (source pin)", () => {
  const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function revealClaimRecord(id)");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /if \(!await navigationBoardRevealClaim\?\.\(id\)\) \{\s*\n\s*notice\(SOURCE_UNAVAILABLE_NOTICE, true\);/,
    "the deep-link path checks the reveal boolean and notices, like navigateClaimRecord");
});
