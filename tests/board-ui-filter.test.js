// Board search + "mine only" filter (PRODUCT-200 client craft, BU-07).
// The claims board had no way to find anything: every loaded claim rendered
// and the only search box in the room covered work items and messages, never
// claims. filterClaims is the pure contract the board's filter bar consumes;
// filterEmptyCopy owns the honest "no matches" note (it must never blame the
// board's contents when the filter is at fault).
import test from "node:test";
import assert from "node:assert/strict";
import { filterClaims, filterEmptyCopy } from "../src/board-ui.js";

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

test("filterEmptyCopy escapes the query it echoes", () => {
  const html = filterEmptyCopy({ q: '<script>"x"' }, 0);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
