// Regression tests for #3275: escrow settlement must be atomic across its
// two stores.
//
// The dispute machine lives in an in-memory Map (BountyEscrow._disputeRecords)
// while dispute snapshots and bounty state persist in SQLite inside a store
// transaction. finalize() marks the machine record resolved/notified BEFORE
// the settlement callback runs; if settlement then throws (here: the journal
// append fails), the DB transaction rolls back but — without the fix — the
// Map keeps "resolved", so every retry dies with a ghost
// "cannot move resolved -> ..." error and the dispute can never settle.
//
// Construction mirrors tests/bounty-escrow.test.js: an in-memory
// node:sqlite store double whose transaction() is a SAVEPOINT (the nesting
// shape RoomStore.transaction has in production), and the escrow's own
// journal seam (_append, the single INSERT INTO bounty_journal) wrapped to
// throw exactly once, on the first settlement write for the target bounty.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, BOUNTY_DISPUTE_ROW_KIND } from "../server/bounty-escrow.mjs";
import { decodeRow } from "../server/persisted-row.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";         // poster lane
const GROK = "id:agent/grokbot";      // worker lane
const INSTINCT = "id:agent/instinct"; // verifier / decider lane
const CODEX = "id:agent/codex";       // challenger lane

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const bal = (escrow, lane) => escrow.balances(ROOM, lane);
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;

// Post -> fund -> claim -> submit (no accept): a dispute then freezes a
// still-locked award, so settlement must attribute before it can split/pay.
function runToSubmitted(escrow, { amount = 10, verifier = null } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// The persisted dispute snapshot, read straight from bounty_disputes —
// independent of the in-memory machine, so the two stores can be compared.
const persistedDispute = (db, disputeId) => {
  const row = db.prepare("SELECT body FROM bounty_disputes WHERE dispute_id=?").get(disputeId);
  assert.ok(row, `no persisted dispute row for ${disputeId}`);
  return decodeRow(row.body, { kind: BOUNTY_DISPUTE_ROW_KIND,
    fields: ["state", "notified", "resolution"],
    defaults: { state: null, notified: false, resolution: null } });
};

const journalRowsFor = (db, bountyId) =>
  db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE bounty_id=?").get(bountyId).n;

// Wrap the escrow's journal append so the FIRST append for `bountyId`
// throws — a one-shot settlement-write failure (e.g. the journal adapter's
// append failing mid-settlement). Later appends pass through, and
// restore() unwraps entirely, modelling a healthy adapter on retry.
const failFirstJournalAppend = (escrow, bountyId) => {
  const original = escrow._append.bind(escrow);
  let fired = false;
  escrow._append = args => {
    if (!fired && args.bountyId === bountyId) {
      fired = true;
      throw new Error("injected journal append failure");
    }
    return original(args);
  };
  return { fired: () => fired, restore: () => { escrow._append = original; } };
};

// Drive a submitted bounty into an adjudicating dispute, fail the first
// settlement journal write during decideDispute, and assert both stores
// rolled back together. Returns everything the retry assertions need.
function driveToFailedSettlement(outcome, reasonCodes) {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { amount: 10, verifier: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "partial credit" });
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "adjudicating");
  assert.equal(persistedDispute(db, dispute.disputeId).state, "adjudicating");
  const journalBefore = journalRowsFor(db, bounty.bountyId);

  const fault = failFirstJournalAppend(escrow, bounty.bountyId);
  assert.throws(
    () => escrow.decideDispute(ROOM, bounty.bountyId, { decider: INSTINCT, outcome, reasonCodes }),
    /injected journal append failure/);
  assert.equal(fault.fired(), true, "the settlement write must actually have been attempted");
  fault.restore();

  // Persisted store rolled back: the bounty is still disputed, with no
  // resolution, and no journal row from the aborted settlement survived.
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "disputed");
  assert.equal(after.resolution, null);
  assert.equal(journalRowsFor(db, bounty.bountyId), journalBefore,
    "no journal move from the aborted settlement may commit");

  // The persisted dispute snapshot rolled back to its pre-decision state:
  // the decide + persist happened inside the same transaction as the
  // settlement, so the snapshot is back to adjudicating, undecided.
  const persisted = persistedDispute(db, dispute.disputeId);
  assert.equal(persisted.state, "adjudicating");
  assert.equal(persisted.notified, false);
  assert.equal(persisted.resolution, null);

  // THE #3275 ASSERTION: the in-memory machine record must match the
  // persisted snapshot. Without the fix it stays "resolved"/notified —
  // the ghost state that blocks every retry.
  const machine = escrow.getDispute(ROOM, dispute.disputeId);
  assert.equal(machine.state, persisted.state,
    `machine (${machine.state}) must match persisted snapshot (${persisted.state})`);
  assert.notEqual(machine.state, "resolved");
  assert.ok(!machine.notified, "machine must not keep the finalized notification");
  assert.equal(machine.resolution, null);
  assert.equal(escrow._disputeRecords.get(dispute.disputeId).state, persisted.state,
    "the raw _disputeRecords Map entry must match the persisted snapshot too");

  // Money is exactly where the dispute left it: award still locked with
  // the poster, challenger bond still locked, nothing attributed/vested.
  assert.equal(bal(escrow, JILL).payable, 90);
  assert.equal(bal(escrow, JILL).locked, 10);
  assert.equal(bal(escrow, CODEX).payable, 97.5);
  assert.equal(bal(escrow, CODEX).locked, 2.5);
  assert.equal(bal(escrow, GROK).attributed, 0);
  assert.equal(bal(escrow, GROK).approved, 0);
  expectConserved(escrow);
  return { escrow, db, bounty, dispute };
}

test("settlement journal failure rolls the dispute machine back with the DB; retry settles (#3275, split)", () => {
  const { escrow, db, bounty, dispute } = driveToFailedSettlement("split", ["criterion-unmet"]);

  // Retry with a healthy journal: the dispute must be decidable again —
  // no ghost "cannot move resolved -> adjudicating" error — and settle
  // end-to-end exactly as an unfailed split does.
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "split");
  assert.equal(settled.state, "approved");
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "resolved");
  assert.equal(persistedDispute(db, dispute.disputeId).state, "resolved",
    "machine and persisted snapshot agree after the successful retry");
  assert.equal(bal(escrow, JILL).payable, 95, "poster: 90 + 5 half refund");
  assert.equal(bal(escrow, CODEX).payable, 100, "challenger bond returned in full");
  assert.equal(bal(escrow, CODEX).locked, 0);
  escrow.closeEpoch(ROOM, {});
  assert.equal(bal(escrow, GROK).payable, 99 + 4.95 + 1, "worker half sweeps at 99% + claim bond back");
  assert.equal(bal(escrow, "pool").payable, 0.05);
  expectConserved(escrow);
});

test("settlement journal failure is outcome-independent: an upheld ruling also retries cleanly (#3275)", () => {
  const { escrow, db, bounty, dispute } = driveToFailedSettlement("upheld", ["criterion-unmet"]);

  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "cancel");
  assert.equal(settled.state, "refunded");
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "resolved");
  assert.equal(persistedDispute(db, dispute.disputeId).state, "resolved");
  assert.equal(bal(escrow, JILL).payable, 100, "full refund, no fee");
  assert.equal(bal(escrow, CODEX).payable, 100, "challenger bond returned");
  expectConserved(escrow);
});
