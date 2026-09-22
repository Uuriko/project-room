// Unit tests for the two-track bounty lifecycle (integration-map candidate #2).
//
// Acceptance track = the verdict on work (evidence-cited):
//   claimed -> submitted -> accepted | disputed -> approved (affirmed) | refunded (rejected)
// Finality track = credit-lot movements (requires a terminal acceptance verdict):
//   locked -> attributed -> paid | refunded
//
// Display states are unchanged; the split is enforced in transition legality,
// every journaled transition records its track, and disputes freeze finality
// while acceptance is re-decided.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BountyEscrow,
  TRACK_ACCEPTANCE, TRACK_FINALITY,
  trackOfJournalKind, trackOfStateTransition,
  stateTransitionLegal, acceptanceTransitionLegal,
} from "../server/bounty-escrow.mjs";

const ROOM = "room-tracks";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // verifier / decider lane
const CODEX = "id:agent/codex";     // challenger lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const DAY = 24 * 3600 * 1000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const journalTracks = (db, bountyId) =>
  db.prepare("SELECT DISTINCT track FROM bounty_journal WHERE room_id=? AND bounty_id=?").all(ROOM, bountyId).map(r => r.track);
const journalCount = (db, bountyId) =>
  db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND bounty_id=?").get(ROOM, bountyId).n;
const eventTracks = (escrow, bountyId) => Object.fromEntries(
  escrow.listEvents(ROOM).filter(e => e.bountyId === bountyId).map(e => [e.type, e.track]));

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const ev = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const att = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm" });

// Post -> fund -> claim -> submit -> accept.
function runToAccepted(escrow, { verifier = INSTINCT } = {}) {
  const bounty = post(escrow, { verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence: ev });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: att() });
  return escrow.getBounty(ROOM, bounty.bountyId);
}
const openDispute = (escrow, bountyId) =>
  escrow.disputeBounty(ROOM, bountyId, { challenger: CODEX, bond: 2.5, grounds: "shoddy work" });

// --- track vocabulary ---------------------------------------------------------

test("track vocabulary: journal kinds and state transitions classify by track", () => {
  assert.equal(TRACK_ACCEPTANCE, "acceptance");
  assert.equal(TRACK_FINALITY, "finality");
  for (const kind of ["escrow-lock", "attribute", "approve", "payout", "refund", "fee",
    "bond-lock", "bond-return", "bond-forfeit", "bond-compensate"])
    assert.equal(trackOfJournalKind(kind), TRACK_FINALITY, kind);
  assert.equal(trackOfJournalKind("genesis"), null);
  assert.equal(trackOfJournalKind("transfer"), null);
  assert.equal(trackOfJournalKind("nope"), null);
  assert.equal(trackOfStateTransition("submitted", "accepted"), TRACK_ACCEPTANCE);
  assert.equal(trackOfStateTransition("claimed", "submitted"), TRACK_ACCEPTANCE);
  assert.equal(trackOfStateTransition("submitted", "disputed"), TRACK_ACCEPTANCE);
  assert.equal(trackOfStateTransition("disputed", "refunded"), TRACK_ACCEPTANCE);
  assert.equal(trackOfStateTransition("accepted", "approved"), TRACK_FINALITY);
  assert.equal(trackOfStateTransition("approved", "paid"), TRACK_FINALITY);
  assert.equal(trackOfStateTransition("funded", "refunded"), TRACK_FINALITY);
  assert.equal(trackOfStateTransition("proposed", "funded"), null); // intake: no track
  assert.equal(trackOfStateTransition("funded", "claimed"), null);  // commitment: no track
  assert.equal(stateTransitionLegal("submitted", "paid"), false);
  assert.equal(stateTransitionLegal("funded", "accepted"), false);
  assert.equal(stateTransitionLegal("disputed", "claimed"), false);
  assert.equal(acceptanceTransitionLegal("submitted", "accepted"), true);
  assert.equal(acceptanceTransitionLegal("disputed", "approved"), true);
  assert.equal(acceptanceTransitionLegal("funded", "accepted"), false);
  assert.equal(acceptanceTransitionLegal("accepted", "paid"), false);
});

// --- accept -> settle ----------------------------------------------------------

test("accept -> settle: finality flows on the acceptance verdict, all journaled with track", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow);
  assert.equal(bounty.state, "accepted");
  // Every journaled transition for the bounty rides the finality track.
  assert.deepEqual(journalTracks(db, bounty.bountyId), [TRACK_FINALITY]);
  // Events split by track: verdicts on acceptance, money moves on finality.
  const tracks = eventTracks(escrow, bounty.bountyId);
  assert.equal(tracks["bounty.submitted"], TRACK_ACCEPTANCE);
  assert.equal(tracks["bounty.accepted"], TRACK_ACCEPTANCE);
  assert.equal(tracks["bounty.funded"], null);
  assert.equal(tracks["bounty.claimed"], null);
  // Challenge window passes unchallenged: the keeper vests, the epoch pays.
  tick(4 * DAY);
  escrow.finalizeBounty(ROOM, bounty.bountyId); // keeper: accepted -> approved
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "approved");
  const closed = escrow.closeEpoch(ROOM); // epoch: approved -> paid
  assert.deepEqual(closed.summary.paid.map(p => p.bountyId), [bounty.bountyId]);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  const after = eventTracks(escrow, bounty.bountyId);
  assert.equal(after["bounty.approved"], TRACK_FINALITY);
  assert.equal(after["bounty.paid"], TRACK_FINALITY);
  assert.deepEqual(journalTracks(db, bounty.bountyId), [TRACK_FINALITY]);
  const paid = escrow.balances(ROOM, GROK);
  assert.equal(paid.payable, 100 - 1 + 9.9 + 1); // genesis - bond + payout(99%) + bond back
  expectConserved(escrow);
});

// --- accept -> dispute: finality freezes ---------------------------------------

test("accept -> dispute: finality freezes while acceptance is re-decided", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow);
  openDispute(escrow, bounty.bountyId);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  const before = journalCount(db, bounty.bountyId);
  // The keeper cannot vest, sweep, or refund while the dispute runs.
  tick(4 * DAY);
  escrow.closeEpoch(ROOM);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  assert.equal(journalCount(db, bounty.bountyId), before);
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId), "invalid_state");
  // The dispute's own settlement records the verdict, then moves finality.
  const decided = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["criterion-unmet"] });
  assert.equal(decided.bounty.state, "approved");
  assert.equal(decided.resolution.kind, "release");
  const tracks = eventTracks(escrow, bounty.bountyId);
  assert.equal(tracks["bounty.disputed"], TRACK_ACCEPTANCE);
  assert.equal(tracks["bounty.released"], TRACK_ACCEPTANCE); // the verdict
  assert.deepEqual(journalTracks(db, bounty.bountyId), [TRACK_FINALITY]);
  escrow.closeEpoch(ROOM);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  expectConserved(escrow);
});

// --- fund -> timeout -> refund ---------------------------------------------------

test("fund -> timeout -> refund: finality-only path needs no acceptance verdict", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  tick(2 * 3600 * 1000); // past the 1h deadline
  const out = escrow.finalizeBounty(ROOM, bounty.bountyId);
  assert.equal(out.action, "refunded");
  assert.equal(out.bounty.state, "refunded");
  assert.deepEqual(journalTracks(db, bounty.bountyId), [TRACK_FINALITY]);
  const tracks = eventTracks(escrow, bounty.bountyId);
  assert.equal(tracks["bounty.refunded"], TRACK_FINALITY);
  assert.equal(escrow.balances(ROOM, JILL).payable, 100); // full refund, no fee
  expectConserved(escrow);
});

// --- illegal transitions ---------------------------------------------------------

test("illegal transitions are rejected on both tracks", () => {
  const { escrow } = makeEscrow();
  // Guard unit: wrong-track and unknown pairs.
  expectCode(() => escrow._acceptanceTransition({ state: "funded", bountyId: "x" }, "accepted", { evidence: {} }),
    "illegal_transition");
  expectCode(() => escrow._acceptanceTransition({ state: "submitted", bountyId: "x" }, "paid", { evidence: {} }),
    "illegal_transition");
  expectCode(() => escrow._acceptanceTransition({ state: "disputed", bountyId: "x" }, "submitted", { evidence: {} }),
    "illegal_transition");
  // Guard unit: acceptance without cited evidence.
  expectCode(() => escrow._acceptanceTransition({ state: "submitted", bountyId: "x" }, "accepted", {}),
    "missing_evidence");
  // Guard unit: finality frozen while disputed.
  expectCode(() => escrow._requireFinalityMove({ state: "disputed", bountyId: "x" }, "approve"),
    "finality_frozen");
  expectCode(() => escrow._requireFinalityMove({ state: "disputed", bountyId: "x" }, "payout"),
    "finality_frozen");
  // Guard unit: finality without a terminal acceptance verdict.
  expectCode(() => escrow._requireFinalityMove({ state: "funded", bountyId: "x" }, "payout"),
    "missing_verdict");
  expectCode(() => escrow._requireFinalityMove({ state: "claimed", bountyId: "x" }, "attribute"),
    "missing_verdict");
  // Integration: disputing before any verdict exists is rejected.
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "x" }),
    "invalid_state");
  // Integration: accepting before submission is rejected.
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: att() }),
    "invalid_state");
});

// --- duplicate-event dedup ---------------------------------------------------------

test("duplicate dispute-finalized packets settle exactly once", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow);
  openDispute(escrow, bounty.bountyId);
  const disputeId = escrow.getBounty(ROOM, bounty.bountyId).disputeId;
  const decided = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(decided.bounty.state, "refunded");
  assert.equal(decided.resolution.kind, "cancel");
  const rowsAfter = journalCount(db, bounty.bountyId);
  const balAfter = escrow.balances(ROOM, JILL).payable;
  // A redelivered finalized packet is a no-op: the settlement ran once.
  const dispute = escrow._disputes.get(disputeId);
  escrow._onDisputeFinalized({ bountyId: bounty.bountyId, outcome: "upheld", terminal: "resolved",
    track: "acceptance", reasonCodes: ["criterion-unmet"],
    bondSnapshot: dispute.bondSnapshot, forfeitedBond: dispute.forfeitedBond });
  assert.equal(journalCount(db, bounty.bountyId), rowsAfter);
  assert.equal(escrow.balances(ROOM, JILL).payable, balAfter);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "refunded");
  // A finalized packet outside the acceptance track is rejected fail-closed.
  expectCode(() => escrow._onDisputeFinalized({ bountyId: bounty.bountyId, outcome: "upheld", terminal: "resolved" }),
    "internal");
  expectConserved(escrow);
});
