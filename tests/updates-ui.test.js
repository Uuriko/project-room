import test from "node:test";
import assert from "node:assert/strict";
import { queryFor, validBasis, updateActions, updateMessageId } from "../src/updates-ui.js";

test("notification actions dismiss attention without offering a second completion workflow", () => {
  const sourceRef = { messageId: "message" };
  for (const state of ["unread", "read"]) assert.deepEqual(updateActions({ state, sourceRef }), ["open", "clear"]);
  for (const state of ["handled", "cleared", "answered"]) assert.deepEqual(updateActions({ state, sourceRef }), ["open"]);
  assert.deepEqual(updateActions({ state: "unread" }), ["clear"]);
});

test("uncertain actions remain retryable even when the item is no longer actionable", () => {
  for (const action of ["open", "done", "clear"]) assert.deepEqual(updateActions({ state: "unconfirmed" }, action), [action]);
  assert.deepEqual(updateActions({ state: "read", sourceRef: { workItemId: "work" } }, "clear"), ["open", "clear"]);
  assert.deepEqual(updateActions({ state: "unconfirmed" }, "invalid"), []);
});

test("queryFor: each filter issues its documented updates query", () => {
  assert.equal(queryFor("needs"), "state=actionable");
  assert.equal(queryFor("mentions"), "state=actionable&kinds=mention");
  assert.equal(queryFor("all"), "state=all");
  assert.equal(queryFor("saved"), "state=actionable");
  assert.equal(queryFor("bogus"), "state=actionable");
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


test("formal requests open their conversation while other request IDs stay scoped", () => {
  const formal = { kind: "request", state: "unread", sourceRef: { requestId: "ask", workItemId: "linked-work" } };
  assert.equal(updateMessageId(formal), "ask");
  assert.deepEqual(updateActions(formal), ["open", "clear"]);
  assert.deepEqual(updateActions({ kind: "open_request", state: "open", sourceRef: { requestId: "ask" } }), ["open"]);
  for (const kind of ["access_request", "invite_request"]) {
    const item = { kind, state: "unread", sourceRef: { requestId: "not-a-message" } };
    assert.equal(updateMessageId(item), undefined);
    assert.deepEqual(updateActions(item), ["clear"]);
  }
});
