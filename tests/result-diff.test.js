// F4: resubmitted native results compare against the exact previous version -
// reviewers see the changed bytes, and oversized texts fail closed to a summary.
import test from "node:test";
import assert from "node:assert/strict";
import { diffResultLines, diffResultSummary } from "../src/workflow.js";

test("changed lines are shown as removed then added, unchanged lines kept", () => {
  const rows = diffResultLines("alpha\nbeta\ngamma", "alpha\nBETA\ngamma\ndelta");
  assert.deepEqual(rows, [
    { type: "same", text: "alpha" },
    { type: "removed", text: "beta" },
    { type: "added", text: "BETA" },
    { type: "same", text: "gamma" },
    { type: "added", text: "delta" }
  ]);
  assert.deepEqual(diffResultSummary(rows), { removedLines: 1, addedLines: 2, changedBytes: 13 });
});

test("identical versions produce no changes", () => {
  const rows = diffResultLines("same\nlines", "same\nlines");
  assert.deepEqual(diffResultSummary(rows), { removedLines: 0, addedLines: 0, changedBytes: 0 });
});

test("a fully replaced result shows every line changed", () => {
  const rows = diffResultLines("one\ntwo", "three\nfour");
  assert.equal(rows.every(row => row.type !== "same"), true);
  assert.deepEqual(diffResultSummary(rows), { removedLines: 2, addedLines: 2, changedBytes: 15 });
});

test("oversized texts fail closed instead of pretending to compare", () => {
  assert.equal(diffResultLines(Array(401).fill("line").join("\n"), "short"), null);
  assert.equal(diffResultLines("short", Array(401).fill("line").join("\n")), null);
});

test("non-text input fails closed", () => {
  assert.throws(() => diffResultLines(null, "text"));
  assert.throws(() => diffResultLines("text", 42));
});
