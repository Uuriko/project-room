// S1 regression: the empty Board used to show every viewer the same
// "Claim work here" line, but the New item form only renders for writers.
// Non-writers got a dead instruction with no next step. This guards the
// viewer-aware copy at the emptyBoardCopy boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { emptyBoardCopy } from "../src/board-ui.js";

test("writers keep the original claim-here copy (backward compatible)", () => {
  const copy = emptyBoardCopy([]);
  assert.ok(copy.startsWith("Claim work here"), `unexpected copy: ${copy}`);
  assert.equal(
    emptyBoardCopy(["work_claim_create"], { canWrite: true, signedIn: true }),
    "Claim work here so people and agents don't collide. Agents can use work_claim_create.",
  );
});

test("signed-in non-writers get a browse + ask-owner next step", () => {
  const copy = emptyBoardCopy([], { canWrite: false, signedIn: true });
  assert.ok(!copy.startsWith("Claim work here"), `still instructs a non-writer to claim: ${copy}`);
  assert.ok(/browse/i.test(copy), `no browse option: ${copy}`);
  assert.ok(/room owner/i.test(copy), `no ask-owner next step: ${copy}`);
});

test("signed-out viewers are told to sign in", () => {
  const copy = emptyBoardCopy([], { canWrite: false, signedIn: false });
  assert.ok(/browse/i.test(copy), `no browse option: ${copy}`);
  assert.ok(/sign in/i.test(copy), `no sign-in next step: ${copy}`);
});

test("omitted options default to the writer copy", () => {
  assert.equal(emptyBoardCopy([]), "Claim work here so people and agents don't collide.");
});
