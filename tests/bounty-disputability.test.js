// DA3-P3 — disputability derivation, pure cases.
//
// The derivation mirrors BountyEscrow.disputeBounty's decider resolution
// (designated decider = disputeDecider ?? verifier, seated only when
// independent of poster and executor). These cases pin the field's truth
// table without any store: designation, precedence, and the two
// independence failures. The escrow read-shape coverage lives in
// tests/bounty-disputability-reads.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { disputabilityFor } from "../server/bounty-disputability.mjs";

const POSTER = "id:agent/jill";
const WORKER = "id:agent/grokbot";
const THIRD = "id:agent/instinct";
const FOURTH = "id:agent/codex";

test("no verifier and no designated decider: undisputable, no_decider_named, no decider", () => {
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: null, disputeDecider: null, claimant: null }),
    { status: "undisputable", reason: "no_decider_named", decider: null });
  // Also with a claimant present: a claim does not create a decider.
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: null, disputeDecider: null, claimant: WORKER }),
    { status: "undisputable", reason: "no_decider_named", decider: null });
});

test("third-party verifier: disputable, decider is the verifier", () => {
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: THIRD, disputeDecider: null, claimant: null }),
    { status: "disputable", reason: null, decider: THIRD });
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: THIRD, disputeDecider: null, claimant: WORKER }),
    { status: "disputable", reason: null, decider: THIRD });
});

test("an explicit dispute decider takes precedence over the verifier, as in disputeBounty", () => {
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: THIRD, disputeDecider: FOURTH, claimant: WORKER }),
    { status: "disputable", reason: null, decider: FOURTH });
  // A designated decider alone (no verifier) is equally a seated designation.
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: null, disputeDecider: FOURTH, claimant: WORKER }),
    { status: "disputable", reason: null, decider: FOURTH });
});

test("verifier is the poster: undisputable, verifier_is_poster (legacy-row configuration)", () => {
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: POSTER, disputeDecider: null, claimant: WORKER }),
    { status: "undisputable", reason: "verifier_is_poster", decider: null });
  // Same flaw via the explicit decider column.
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: THIRD, disputeDecider: POSTER, claimant: WORKER }),
    { status: "undisputable", reason: "verifier_is_poster", decider: null });
});

test("verifier becomes the executor: disputable before the claim, verifier_is_executor after", () => {
  const base = { poster: POSTER, verifier: WORKER, disputeDecider: null };
  assert.deepEqual(disputabilityFor({ ...base, claimant: null }),
    { status: "disputable", reason: null, decider: WORKER });
  assert.deepEqual(disputabilityFor({ ...base, claimant: WORKER }),
    { status: "undisputable", reason: "verifier_is_executor", decider: null });
  // A different claimant leaves the designation intact.
  assert.deepEqual(disputabilityFor({ ...base, claimant: THIRD }),
    { status: "disputable", reason: null, decider: WORKER });
});

test("designated decider is the executor: verifier_is_executor, whoever designated them", () => {
  assert.deepEqual(
    disputabilityFor({ poster: POSTER, verifier: THIRD, disputeDecider: WORKER, claimant: WORKER }),
    { status: "undisputable", reason: "verifier_is_executor", decider: null });
});

test("no fallback is ever reported as a decider: the poster is not substituted in", () => {
  // disputeBounty seats only a designated decider; with none designated the
  // field must say so, never name the poster (or any other party) instead.
  const out = disputabilityFor({ poster: POSTER, verifier: null, disputeDecider: null, claimant: WORKER });
  assert.equal(out.decider, null);
  assert.notEqual(out.decider, POSTER);
});
