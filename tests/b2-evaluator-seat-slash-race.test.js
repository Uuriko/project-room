// B2 money-audit: fail-first regression for the slash-race in
// server/evaluator-seat.mjs finalizeVerdict.
//
// Contract: a fraud slash (slashBond / resolveChallenge-upheld) that lands
// mid-assignment must not be double-counted when the assignment later
// finalizes. The encumbered slice is already gone (moved to slashed);
// finalize may only convert what is still encumbered. Invariants:
//   1. encumbered_millis never goes negative;
//   2. forfeited + slashed + released never exceeds posted (no double-count);
//   3. a fully-slashed bond stays "slashed" — finalize must not resurrect it
//      to "active".
// Regression: finalizeVerdict unconditionally did
//   encumbered - assignment_slice and set state "active", so a mid-assignment
//   full slash was followed by encumbered = -slice, 1000 extra phantom units
//   in forfeited, and the fraudster's bond reactivated.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  createEvaluatorSeat,
  commitmentFor,
  EvaluatorSeatError,
} from "../server/evaluator-seat.mjs";

const ROOM = "room-b2-slash-race";
const CLIENT = "id:agent/client";
const PROVIDER = "id:agent/provider";
const EVA = "id:agent/eva";

let nowMs = 1_787_000_000_000;
const tick = ms => { nowMs += ms; };

function makeSeat(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT b2_seat_test");
    try { const out = fn(); db.exec("RELEASE b2_seat_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO b2_seat_test"); db.exec("RELEASE b2_seat_test"); throw error; }
  };
  return createEvaluatorSeat({ db, transaction, readTransaction: transaction }, { now: () => nowMs });
}

test("finalizeVerdict after a mid-assignment full fraud slash keeps bond accounting conserved", () => {
  const seat = makeSeat();
  const bond = seat.postBond(ROOM, { evaluator: EVA, amountMillis: 5000 });
  seat.assignPanel(ROOM, "job-slash-race", {
    client: CLIENT, provider: PROVIDER, candidates: [EVA],
    jobValueMillis: 200_000, panelSize: 1,
  });
  assert.equal(seat.getBond(ROOM, EVA).encumberedMillis, 1000);

  // Mid-assignment, a signed decider proves fraud and slashes the whole bond.
  const slash = seat.slashBond(ROOM, bond.bondId, {
    reason: "double-sign",
    proof: { commits: ["a".repeat(64), "b".repeat(64)] },
    decider: "judge-x",
  });
  assert.equal(slash.slashedMillis, 5000);
  const slashed = seat.getBond(ROOM, EVA);
  assert.equal(slashed.state, "slashed");
  assert.equal(slashed.encumberedMillis, 0);

  // Windows pass; the assignment finalizes with no valid reveals.
  tick(25 * 3600 * 1000);
  tick(25 * 3600 * 1000);
  const done = seat.finalizeVerdict(ROOM, "job-slash-race");
  assert.equal(done.state, "deadlocked");

  const after = seat.getBond(ROOM, EVA);
  assert.ok(after.encumberedMillis >= 0,
    `no negative balances: encumberedMillis went ${after.encumberedMillis}`);
  const moved = after.forfeitedMillis + after.slashedMillis + after.releasedMillis;
  assert.ok(moved <= after.postedMillis,
    `no double-count: ${moved} units moved out of ${after.postedMillis} posted`);
  assert.equal(after.slashedMillis, 5000, "the fraud slash is preserved in full");
  assert.equal(after.state, "slashed",
    "a fully-slashed bond must not be resurrected to active by finalize");
});

test("finalizeVerdict after a partial mid-assignment slash converts only the surviving encumbrance", () => {
  const seat = makeSeat();
  const bond = seat.postBond(ROOM, { evaluator: EVA, amountMillis: 5000 });
  seat.assignPanel(ROOM, "job-partial-slash", {
    client: CLIENT, provider: PROVIDER, candidates: [EVA],
    jobValueMillis: 200_000, panelSize: 1,
  });
  // Slash 2000 of the 5000 posted: 1000 comes off the encumbered slice,
  // 1000 off free balance. The slice is gone; 0 remains encumbered.
  const slash = seat.slashBond(ROOM, bond.bondId, {
    reason: "evidence-fraud", proof: { artifact: "x" }, decider: "judge-x",
    amountMillis: 2000,
  });
  assert.equal(slash.slashedMillis, 2000);
  assert.equal(seat.getBond(ROOM, EVA).encumberedMillis, 0);

  tick(25 * 3600 * 1000);
  tick(25 * 3600 * 1000);
  seat.finalizeVerdict(ROOM, "job-partial-slash");

  const after = seat.getBond(ROOM, EVA);
  assert.ok(after.encumberedMillis >= 0,
    `no negative balances: encumberedMillis went ${after.encumberedMillis}`);
  const moved = after.forfeitedMillis + after.slashedMillis + after.releasedMillis;
  assert.ok(moved <= after.postedMillis,
    `no double-count: ${moved} units moved out of ${after.postedMillis} posted`);
  assert.equal(after.slashedMillis, 2000);
});

test("the normal path is unchanged: valid reveal releases the slice on finalize", () => {
  const seat = makeSeat();
  seat.postBond(ROOM, { evaluator: EVA, amountMillis: 5000 });
  const salt = randomBytes(16).toString("hex");
  seat.assignPanel(ROOM, "job-normal", {
    client: CLIENT, provider: PROVIDER, candidates: [EVA],
    jobValueMillis: 200_000, panelSize: 1,
  });
  const commit = commitmentFor({ verdict: "accept", evidenceHash: "ev-1", salt });
  seat.commitVerdict(ROOM, "job-normal", EVA, commit);
  tick(25 * 3600 * 1000); // -> revealing
  seat.revealVerdict(ROOM, "job-normal", EVA, { verdict: "accept", evidenceHash: "ev-1", salt });
  tick(25 * 3600 * 1000); // -> past reveal window
  const done = seat.finalizeVerdict(ROOM, "job-normal");
  assert.equal(done.state, "finalized");
  assert.equal(done.verdict, "accept");
  const after = seat.getBond(ROOM, EVA);
  assert.equal(after.encumberedMillis, 0);
  assert.equal(after.releasedMillis, 1000);
  assert.equal(after.state, "active");
  assert.ok(after.availableMillis === 4000, `available is ${after.availableMillis}`);
});
