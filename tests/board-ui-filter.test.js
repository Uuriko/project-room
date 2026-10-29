// Board search + "mine only" filter (PRODUCT-200 client craft, BU-07).
// The claims board had no way to find anything: every loaded claim rendered
// and the only search box in the room covered work items and messages, never
// claims. filterClaims is the pure contract the board's filter bar consumes;
// filterEmptyCopy owns the honest "no matches" note (it must never blame the
// board's contents when the filter is at fault).
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, filterClaims, filterEmptyCopy } from "../src/board-ui.js";

const claim = (id, extra = {}) => ({ id, title: id, state: "unclaimed", owner: null, dependsOn: [], ...extra });
const members = { w1: { displayName: "Wren" }, w2: { displayName: "Sable" } };
const items = [
  claim("alpha", { title: "Fix login redirect", owner: "w1", files: ["src/auth.mjs"], note: "oauth loop on retry" }),
  claim("beta", { title: "Polish empty states", owner: "w2", files: ["src/board.css"] }),
  claim("gamma", { title: "Write release notes", owner: null }),
];

test("filterClaims with no filter returns every item in order", () => {
  assert.deepEqual(filterClaims(items, {}).map(i => i.id), ["alpha", "beta", "gamma"]);
  assert.deepEqual(filterClaims(items).map(i => i.id), ["alpha", "beta", "gamma"]);
  assert.deepEqual(filterClaims(null, { q: "x" }), []);
});

test("filterClaims matches title case-insensitively", () => {
  assert.deepEqual(filterClaims(items, { q: "LOGIN" }).map(i => i.id), ["alpha"]);
});

test("filterClaims matches note, owner name, files, and id", () => {
  assert.deepEqual(filterClaims(items, { q: "oauth" }).map(i => i.id), ["alpha"]);
  assert.deepEqual(filterClaims(items, { q: "sable" }, null, members).map(i => i.id), ["beta"]);
  assert.deepEqual(filterClaims(items, { q: "board.css" }).map(i => i.id), ["beta"]);
  assert.deepEqual(filterClaims(items, { q: "gamma" }).map(i => i.id), ["gamma"]);
});

test("filterClaims trims the query and never matches an empty query", () => {
  assert.deepEqual(filterClaims(items, { q: "  " }).map(i => i.id), ["alpha", "beta", "gamma"]);
  assert.deepEqual(filterClaims(items, { q: "zz-nope" }), []);
});

test("filterClaims mine keeps only the viewer's claims", () => {
  assert.deepEqual(filterClaims(items, { mine: true }, "w1").map(i => i.id), ["alpha"]);
  assert.deepEqual(filterClaims(items, { mine: true }, "nobody"), []);
  // With no viewer there is no "mine": the toggle narrows to nothing, honestly.
  assert.deepEqual(filterClaims(items, { mine: true }, null), []);
});

test("filterClaims composes mine AND query (narrowing, never widening)", () => {
  assert.deepEqual(filterClaims(items, { q: "polish", mine: true }, "w2").map(i => i.id), ["beta"]);
  assert.deepEqual(filterClaims(items, { q: "polish", mine: true }, "w1"), []);
  assert.deepEqual(filterClaims(items, { q: "e", mine: true }, "w1").map(i => i.id), ["alpha"]);
});

test("filterEmptyCopy stays silent when no filter is active", () => {
  assert.equal(filterEmptyCopy({}, 0), "");
  assert.equal(filterEmptyCopy({}, 3), "");
  assert.equal(filterEmptyCopy(null, 0), "");
});

test("filterEmptyCopy stays silent when the filter matches something", () => {
  assert.equal(filterEmptyCopy({ q: "login" }, 2), "");
  assert.equal(filterEmptyCopy({ mine: true }, 1), "");
});

test("filterEmptyCopy blames the filter, never the board", () => {
  const html = filterEmptyCopy({ q: "zz-nope" }, 0);
  assert.match(html, /No claims match/);
  assert.match(html, /zz-nope/);
  assert.match(html, /Clear the filter/);
  const mineOnly = filterEmptyCopy({ mine: true }, 0);
  assert.match(mineOnly, /No claims match/);
  assert.match(mineOnly, /Clear the filter/);
});

// --- boardHtml under a filter: the filter narrows display only (#2969) ---
// Placement and dependency status are facts about the full loaded board.
// Filtering first and placing only the visible subset made a completed
// prerequisite that the search did not match look unmet, moving its
// dependent from Ready to Blocked and reporting its status as unknown.

const BOARD_NOW = Date.parse("2026-10-13T00:00:00Z");
const boardViewer = { id: "u1", manage: false, owner: false, write: true };

function columnSection(html, id) {
  const start = html.indexOf(`<section aria-labelledby="board-col-${id}">`);
  assert.notEqual(start, -1, `column ${id} renders`);
  const next = html.indexOf("<section", start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}

test("boardHtml search matching a dependent but not its completed prerequisite keeps it Ready", () => {
  const board = [
    claim("prereq", { title: "Set up the database", state: "done", owner: "w1", updatedAt: "2026-10-12T00:00:00Z" }),
    claim("dependent", { title: "Ship the feature", dependsOn: ["prereq"] }),
  ];
  const html = boardHtml(board, null, boardViewer, members, BOARD_NOW, { filter: { q: "Ship the feature" } });
  // The filter still narrows display: the prerequisite card is not rendered.
  assert.ok(!html.includes('data-claim-id="prereq"'), "filtered-out prerequisite is not displayed");
  const ready = columnSection(html, "ready");
  const blocked = columnSection(html, "blocked");
  assert.ok(ready.includes('data-claim-id="dependent"'), "dependent stays in Ready");
  assert.ok(!blocked.includes('data-claim-id="dependent"'), "dependent is not demoted to Blocked");
  // Dependency status resolves against the full board, not the visible subset.
  assert.ok(ready.includes("Completed"), "prerequisite reports Completed");
  assert.ok(!html.includes("Not loaded or unavailable; status unknown"), "loaded prerequisite is not reported unknown");
  assert.ok(ready.includes('data-claim-action="claim"'), "ready dependent is claimable");
});

test("boardHtml search matching a dependent but not its unfinished prerequisite keeps it Blocked", () => {
  const board = [
    claim("prereq", { title: "Set up the database", state: "in_progress", owner: "w1" }),
    claim("dependent", { title: "Ship the feature", dependsOn: ["prereq"] }),
  ];
  const html = boardHtml(board, null, boardViewer, members, BOARD_NOW, { filter: { q: "Ship the feature" } });
  assert.ok(!html.includes('data-claim-id="prereq"'), "filtered-out prerequisite is not displayed");
  const blocked = columnSection(html, "blocked");
  assert.ok(blocked.includes('data-claim-id="dependent"'), "dependent stays in Blocked");
  assert.ok(!columnSection(html, "ready").includes('data-claim-id="dependent"'), "dependent is not promoted to Ready");
  assert.ok(blocked.includes("In progress"), "prerequisite reports its real status");
  assert.ok(!html.includes("Not loaded or unavailable; status unknown"), "loaded prerequisite is not reported unknown");
  assert.ok(!blocked.includes('data-claim-action="claim"'), "blocked dependent is not claimable");
});

test("filterEmptyCopy escapes the query it echoes", () => {
  const html = filterEmptyCopy({ q: '<script>"x"' }, 0);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

// --- #3909 board-UI kernel mirrors: Renew lease gate, claim cap, record order ---

const isoAt = ms => new Date(ms).toISOString();
const cardOf = (html, id) => {
  const start = html.indexOf(`<article class="claim-card" data-claim-id="${id}">`);
  assert.notEqual(start, -1, `card ${id} renders`);
  const next = html.indexOf("<article", start + 1);
  return html.slice(start, next === -1 ? html.length : next);
};

test("boardHtml offers Renew only on a claim with a live lease (#3909 F11)", () => {
  const viewer = { id: "w1", manage: false, owner: false, write: true };
  const live = claim("live", { state: "claimed", owner: "w1", leaseExpiresAt: isoAt(BOARD_NOW + 3600000) });
  const leaseless = claim("leaseless", { state: "claimed", owner: "w1", leaseExpiresAt: null });
  const lapsed = claim("lapsed", { state: "in_progress", owner: "w1", leaseExpiresAt: isoAt(BOARD_NOW - 60000) });
  const html = boardHtml([live, leaseless, lapsed], null, viewer, members, BOARD_NOW, {});
  assert.ok(cardOf(html, "live").includes('data-claim-action="renew"'), "a live lease can be renewed");
  assert.ok(!cardOf(html, "leaseless").includes('data-claim-action="renew"'), "no lease, no Renew");
  assert.ok(!cardOf(html, "lapsed").includes('data-claim-action="renew"'), "a lapsed lease is claimed again, not renewed");
});

test("boardHtml suppresses Claim at the per-member open-claim cap, with the refusal as a hint (#3909 F12)", () => {
  const viewer = { id: "w1", manage: false, owner: false, write: true };
  const held = claim("held", { state: "in_progress", owner: "w1", leaseExpiresAt: isoAt(BOARD_NOW + 7200000) });
  const openOne = claim("open-one", { title: "Open one" });
  const atCap = boardHtml([held, openOne], null, viewer, members, BOARD_NOW, { cap: 1 });
  assert.ok(!cardOf(atCap, "open-one").includes('data-claim-action="claim"'), "at cap, no Claim button");
  assert.ok(cardOf(atCap, "open-one").includes("You already hold the maximum number of open claims"), "the route's refusal copy is the hint");
  const underCap = boardHtml([held, openOne], null, viewer, members, BOARD_NOW, { cap: 2 });
  assert.ok(cardOf(underCap, "open-one").includes('data-claim-action="claim"'), "under cap, Claim renders");
});

test("boardHtml renders claim-record history newest-first (#3909 F14)", () => {
  const item = claim("hist", { state: "done", owner: "w1", updatedAt: isoAt(BOARD_NOW - 60000),
    history: [
      { action: "created", agentId: "w1", at: isoAt(BOARD_NOW - 300000) },
      { action: "claimed", agentId: "w1", at: isoAt(BOARD_NOW - 200000) },
      { action: "state:done", agentId: "w1", at: isoAt(BOARD_NOW - 60000) },
    ] });
  const html = boardHtml([item], null, boardViewer, members, BOARD_NOW, {});
  const card = cardOf(html, "hist");
  const doneAt = card.indexOf("state:done"), claimedAt = card.indexOf("claimed"), createdAt = card.indexOf("created");
  assert.ok(doneAt !== -1 && claimedAt !== -1 && createdAt !== -1, "all history rows render");
  assert.ok(doneAt < claimedAt && claimedAt < createdAt, "the newest history entry renders first");
});
