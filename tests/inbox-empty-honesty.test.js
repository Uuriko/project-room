// WAVE-500 g3a6 empty-state honesty audit.
//
// BUG 1: #inbox-empty ("Your inbox is empty. Connect Gmail to bring in your
// email.") is visible in the static HTML, so it showed through the initial
// list read ("Loading…" in #inbox-status) and stayed visible after a failed
// read (status "Couldn't load inbox. Try again."). Both are lies: while
// loading or on failure we do not know whether the inbox is empty. The note
// may only appear after a successful read that returned zero rows.
//
// BUG 2: a failed inbox message search showed "Couldn't load inbox. Try
// again." — the inbox itself had loaded fine; the search failed. The error
// must blame the search.
//
// Fail-first: pre-fix, inboxEmptyVisible/inboxSearchErrorText do not exist,
// so the import throws and every test below fails.
import test from "node:test";
import assert from "node:assert/strict";
import { inboxEmptyVisible, inboxSearchErrorText } from "../src/inbox-ui.js";

// --- BUG 1: the empty note must not lie about unknown state ---

test("empty note is hidden while the list read is in flight", () => {
  assert.equal(inboxEmptyVisible({ readOk: false, rowCount: 0 }), false);
});

test("empty note is hidden on a failed read (emptiness is unknown)", () => {
  assert.equal(inboxEmptyVisible({ readOk: false, rowCount: 5 }), false);
});

test("empty note is hidden when the read succeeded with rows", () => {
  assert.equal(inboxEmptyVisible({ readOk: true, rowCount: 3 }), false);
});

test("empty note is visible only after a successful read of zero rows", () => {
  assert.equal(inboxEmptyVisible({ readOk: true, rowCount: 0 }), true);
});

test("defaults hide the note (no successful read yet)", () => {
  assert.equal(inboxEmptyVisible(), false);
});

// --- BUG 2: search failure must blame the search ---

test("search failure copy blames the search, not the inbox load", () => {
  const text = inboxSearchErrorText(new Error("boom"));
  assert.ok(!/load inbox/i.test(text), `blames the inbox load: ${text}`);
  assert.ok(/search/i.test(text), `does not mention the search: ${text}`);
});

test("search failure copy does not pretend the inbox failed to load", () => {
  const text = inboxSearchErrorText({ status: 500 });
  assert.ok(!/couldn.t load inbox/i.test(text), `misattributes the failure: ${text}`);
});
