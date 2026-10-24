import test from "node:test";
import assert from "node:assert/strict";
import { checkCard, summarizeChecks } from "../server/check-card.mjs";

const ok = n => Array.from({ length: n }, (_, i) => ({ name: `job${i}`, conclusion: "success" }));

test("all green reads 'Checks: N of N pass'", () => {
  const c = summarizeChecks([...ok(42), { name: "approval", conclusion: "neutral" }]);
  assert.equal(c.line, "Checks: 42 of 42 pass");
  assert.equal(c.state, "green");
});
test("failures are named and win over pending", () => {
  const c = summarizeChecks([...ok(2), { name: "lint", conclusion: "failure" }, { name: "e2e", conclusion: null }]);
  assert.equal(c.state, "red");
  assert.equal(c.line, "Checks: 2 of 4 pass, 1 failing (lint), 1 running");
});
test("no runs is pending, not green", () => {
  assert.equal(summarizeChecks([]).state, "pending");
});
test("card text is two monospace-friendly lines with status and head", () => {
  const card = checkCard({ number: 4316, title: "  Fix   keychain ", headSha: "abcdef1234", mergeable: true }, ok(3));
  assert.equal(card.text, "#4316 Fix keychain\nChecks: 3 of 3 pass   open   head abcdef12");
  assert.equal(checkCard({ number: 1, merged: true }).status, "merged");
  assert.equal(checkCard({ number: 2, mergeable: false }).status, "conflict");
  assert.doesNotMatch(card.text, /\p{Extended_Pictographic}/u);
});
test("rejects a card without a PR number", () => {
  assert.throws(() => checkCard({}), TypeError);
});
