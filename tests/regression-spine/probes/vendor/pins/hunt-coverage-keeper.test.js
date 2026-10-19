// HUNT-COVERAGE (2026-10-18) — mutation-survivor pins for the escrow
// keeper's due-scan (server/bounty-epoch-keeper.mjs DUE_WHERE).
//
// Two deliberate mutations survived the keeper's own suite (9 tests) and
// the incident-eval catalogue:
//   M01 — dropping 'claimed' from the due-scan's state list: a claimed
//         bounty past its deadline never became due, so the timeout
//         refund _keeperPass implements for exactly that state never ran.
//         This is the F1 shape (a state silently absent from the scan
//         while the settlement path handles it fine).
//   M02 — '<' for '<=' in the same scan: a bounty due exactly at its
//         deadline was not due; it waited for a later tick that, at the
//         deadline boundary, is one full job cadence late.
// Construction mirrors tests/bounty-epoch-keeper.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { progressEscrowEpochs } from "../server/bounty-epoch-keeper.mjs";

const ROOM = "room-hunt-keeper";
const JILL = "id:agent/jill";   // poster lane
const GROK = "id:agent/grokbot"; // worker lane
const DAY_MS = 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld() {
  nowMs = 1_786_000_000_000;
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { store, escrow };
}

// Post -> fund -> claim, never submitted: the free-miss shape whose only
// settlement path is the keeper's deadline scan.
function runToClaimed(world, deadlineMs) {
  const bounty = world.escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(deadlineMs) }).bounty;
  world.escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  world.escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  return world.escrow.getBounty(ROOM, bounty.bountyId);
}

const keeper = world => progressEscrowEpochs(world.store, { now: nowMs, escrow: world.escrow });

test("M01: a claimed bounty past its deadline is due and timeout-refunded by the keeper", () => {
  const world = makeWorld();
  const bounty = runToClaimed(world, 1 * DAY_MS);
  nowMs += 2 * DAY_MS; // past the deadline, never submitted
  const summary = keeper(world);
  assert.equal(summary.due, 1, "a claimed bounty past deadline must register as due");
  assert.equal(summary.refunded, 1, "the keeper timeout-refunds it in the same pass");
  assert.equal(world.escrow.getBounty(ROOM, bounty.bountyId).state, "refunded");
  assert.equal(world.escrow.verifyConservation(ROOM).ok, true);
});

test("M02: a claimed bounty is due exactly at its deadline, not one tick later", () => {
  const world = makeWorld();
  const bounty = runToClaimed(world, 1 * DAY_MS);
  nowMs += 1 * DAY_MS; // now == deadline, to the millisecond
  const summary = keeper(world);
  assert.equal(summary.due, 1, "deadline equality is due (the due-scan compares <=)");
  assert.equal(world.escrow.getBounty(ROOM, bounty.bountyId).state, "refunded");
  assert.equal(world.escrow.verifyConservation(ROOM).ok, true);
});
