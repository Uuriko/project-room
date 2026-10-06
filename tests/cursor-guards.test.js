// Cursor guard contract from src/work-selectors.js: workInvolvingMe and
// needsAttention validate their cursor inputs and throw CursorError with
// machine-readable codes. Callers branch on err.code, so the code surviving
// the throw is the contract under test.
import test from "node:test";
import assert from "node:assert/strict";
import { CursorError, workInvolvingMe, needsAttention } from "../src/work-selectors.js";

test("CursorError is an Error that carries its machine-readable code", () => {
  const error = new CursorError("cursor.member_required", "workInvolvingMe requires a memberId");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof CursorError);
  assert.equal(error.code, "cursor.member_required");
  assert.equal(error.message, "workInvolvingMe requires a memberId");
});

const codeOf = fn => {
  try { fn(); } catch (error) { return error instanceof CursorError ? error.code : `not-a-cursor-error:${error?.constructor?.name}`; }
  return "did-not-throw";
};

test("workInvolvingMe rejects a missing or malformed work-item projection", () => {
  assert.equal(codeOf(() => workInvolvingMe({ workItems: null, memberId: "m1" })), "cursor.work_items_required");
  assert.equal(codeOf(() => workInvolvingMe({ workItems: [], memberId: "m1" })), "cursor.work_items_required");
  assert.equal(codeOf(() => workInvolvingMe({ memberId: "m1" })), "cursor.work_items_required");
});

test("workInvolvingMe rejects a missing memberId", () => {
  assert.equal(codeOf(() => workInvolvingMe({ workItems: {}, memberId: "" })), "cursor.member_required");
  assert.equal(codeOf(() => workInvolvingMe({ workItems: {} })), "cursor.member_required");
});

test("needsAttention rejects a missing or malformed work-item projection", () => {
  assert.equal(codeOf(() => needsAttention({ workItems: "nope", memberId: "m1" })), "cursor.work_items_required");
  assert.equal(codeOf(() => needsAttention({ workItems: null, memberId: "m1" })), "cursor.work_items_required");
});

test("needsAttention rejects a missing memberId", () => {
  assert.equal(codeOf(() => needsAttention({ workItems: {}, memberId: null })), "cursor.member_required");
});
