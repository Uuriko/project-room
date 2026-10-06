// COVERAGE CREW lane5: unit tests for the pure Updates helpers in
// src/updates-ui.js (queryFor, visible, validBasis).
// Authoring gate: these guard the /updates wire queries each filter issues
// (a wrong query string loads the wrong items), the saved-filter semantics
// (opening a row marks it read; the saved tab must list read items), and the
// basis-token gate for marking actions (an invalid basis must force a
// refresh, never a write). Existing coverage: none — tests/ has zero
// references to src/updates-ui.js. mountUpdates itself is DOM and client
// code; the three helpers were extracted as exports without touching their
// logic so they can be tested without a DOM stub.
import test from "node:test";
import assert from "node:assert/strict";
import { queryFor, visible, validBasis } from "../src/updates-ui.js";

test("queryFor: each filter issues its documented updates query", () => {
  assert.equal(queryFor("needs"), "state=actionable");
  assert.equal(queryFor("mentions"), "state=actionable&kinds=mention");
  assert.equal(queryFor("all"), "state=all");
  assert.equal(queryFor("saved"), "state=all");
  assert.equal(queryFor("bogus"), "state=actionable");
});

test("visible: the saved filter lists read items only", () => {
  const items = [
    { id: "a", state: "read" },
    { id: "b", state: "unread" },
    { id: "c", state: "read" },
  ];
  assert.deepEqual(visible(items, "saved").map(item => item.id), ["a", "c"]);
});

test("visible: other filters pass every item through", () => {
  const items = [
    { id: "a", state: "read" },
    { id: "b", state: "unread" },
  ];
  assert.deepEqual(visible(items, "needs").map(item => item.id), ["a", "b"]);
  assert.deepEqual(visible(items, "mentions").map(item => item.id), ["a", "b"]);
  assert.deepEqual(visible(items, "all").map(item => item.id), ["a", "b"]);
});

test("validBasis: accepts ub1_ plus 64 lowercase hex chars, nothing else", () => {
  const good = `ub1_${"a".repeat(64)}`;
  assert.equal(validBasis(good), true);
  assert.equal(validBasis(`ub1_${"0123456789abcdef".repeat(4)}`), true);
  assert.equal(validBasis(`ub1_${"A".repeat(64)}`), false);
  assert.equal(validBasis(`ub1_${"a".repeat(63)}`), false);
  assert.equal(validBasis(`ub1_${"a".repeat(65)}`), false);
  assert.equal(validBasis(`ub2_${"a".repeat(64)}`), false);
  assert.equal(validBasis("ub1_nothex!!"), false);
  assert.equal(validBasis(""), false);
  assert.equal(validBasis(null), false);
  assert.equal(validBasis(undefined), false);
  assert.equal(validBasis(42), false);
});
