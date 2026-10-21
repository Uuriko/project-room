import test from "node:test";
import assert from "node:assert/strict";
import { queryFor, validBasis } from "../src/updates-ui.js";

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
