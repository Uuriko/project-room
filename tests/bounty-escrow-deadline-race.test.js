// Regression tests for #3591: bounty escrow deadline/challenge boundaries
// were a race — accept-vs-finalize and dispute-vs-finalize outcomes for
// identical facts depended on who poked the bounty first. The fix is the
// issue's option 1 (self-finalizing entry points): acceptWork and
// disputeBounty run the keeper pass for the target bounty before
// evaluating state, and closeEpoch's keeper sweep includes 'submitted'.
// Every outcome below is a function of facts + the clock only.
//
// Scenario matrix (submit timing x entry-point ordering):
//   accept:  in-window accept succeeds (unchanged); accept at deadline-1ms
//            succeeds; accept at/past deadline settles unverified and is
//            refused — identical end state to finalize-first; the
//            settlement COMMITS even though the accept throws.
//   dispute: on submitted pre-deadline opens (unchanged); on submitted
//            post-deadline settles unverified and is refused — identical
//            end state to finalize-first; on accepted in-window opens
//            (unchanged); on accepted at/past challenge end approves and
//            is refused — identical end state to finalize-first.
//   epoch:   closeEpoch settles a past-deadline submitted bounty exactly
//            like finalizeBounty, and leaves in-review work untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";           // poster / human approver
const GROK = "id:agent/grokbot";        // worker (claimant)
const INSTINCT = "id:agent/instinct";   // verifier / challenger lane
const CODEX = "id:agent/codex";         // challenger lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const CHALLENGE_WINDOW_SMALL_MS = 24 * 3600 * 1000; // < 1 credit bounties

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
const expectCode = (fn, code, messagePattern = null) => {
  try { fn(); } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (messagePattern) assert.match(error.message, messagePattern);
    return;
  }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const journalRows = db => db.prepare("SELECT COUNT(*) AS c FROM bounty_journal WHERE room_id=?").get(ROOM).c;

const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

// Post -> fund -> claim -> submit. `submitTick` advances the clock before
// submitting, so callers place the submission precisely against the deadline.
function runToSubmitted(escrow, { amount = 10, verifier = null, deadlineMs = 60_000, submitTick = 30_000 } = {}) {
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(deadlineMs), verifierId: verifier }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(submitTick);
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// The order-independent facts about a bounty: state, settlement verdict,
// every lane's balance, and the journal size.
function snapshot(escrow, db, bountyId) {
  const bounty = escrow.getBounty(ROOM, bountyId);
  const s = bounty.resolution?.settlement ?? null;
  return { state: bounty.state,
    settlement: s ? { kind: s.kind, workerMillis: s.workerMillis, refundMillis: s.refundMillis } : null,
    jill: bal(escrow, JILL), grok: bal(escrow, GROK), codex: bal(escrow, CODEX),
    pool: bal(escrow, "pool"), journal: journalRows(db) };
}

// Run one setup script against two fresh escrows on the identical clock
// path, apply a different act to each, and return both contexts so the
// test can compare end states. The clock is restored between setups so
// settlement timestamps are comparable.
function compareOrders(setup, actA, actB) {
  const saved = nowMs;
  const a = makeEscrow(); const bountyA = setup(a.escrow);
  const afterSetup = nowMs;
  actA(a.escrow, bountyA);
  nowMs = saved;
  const b = makeEscrow(); const bountyB = setup(b.escrow);
  assert.equal(nowMs, afterSetup, "setup must be clock-deterministic");
  actB(b.escrow, bountyB);
  return [{ ...a, bountyId: bountyA.bountyId }, { ...b, bountyId: bountyB.bountyId }];
}

// --- accept path -----------------------------------------------------------

test("accept matrix: in-window accept succeeds (unchanged)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, {});
  const { bounty: accepted } = escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() });
  assert.equal(accepted.state, "accepted");
  assert.ok(accepted.challengeEndsMs > nowMs, "challenge window opened");
  expectConserved(escrow);
});

test("accept matrix: accept at deadline-1ms succeeds; at the deadline it self-finalizes and is refused", () => {
  { // deadline - 1ms: still the verifier's move.
    const { escrow } = makeEscrow();
    const bounty = runToSubmitted(escrow, { submitTick: 59_998 });
    tick(1); // now == deadline - 1ms
    const { bounty: accepted } = escrow.acceptWork(ROOM, bounty.bountyId,
      { acceptor: JILL, verifierAttestation: attest() });
    assert.equal(accepted.state, "accepted");
    expectConserved(escrow);
  }
  { // exactly the deadline: the keeper boundary (now >= deadlineMs) has passed.
    const { escrow } = makeEscrow();
    const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
    tick(1_000); // now == deadline exactly
    expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
      { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /refunded, not awaiting acceptance/);
    const settled = escrow.getBounty(ROOM, bounty.bountyId);
    assert.equal(settled.state, "refunded");
    assert.equal(settled.resolution.settlement.kind, "unverified");
    expectConserved(escrow);
  }
});

test("accept race (issue repro): submitted at deadline-1s, accept at deadline+1s — same end state as finalize-first", () => {
  const setup = escrow => {
    const bounty = runToSubmitted(escrow, { submitTick: 59_000 }); // on-time submit
    tick(2_000); // deadline + 1s: the review window (deadline - submitTime) was 1s
    return bounty;
  };
  const [finalizeFirst, acceptOnly] = compareOrders(setup,
    (escrow, bounty) => { // the old keeper-first world
      const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
      assert.equal(fin.action, "refunded");
      expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
        { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /refunded, not awaiting acceptance/);
    },
    (escrow, bounty) => { // the accept is the first poke: it self-finalizes
      expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
        { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /refunded, not awaiting acceptance/);
    });
  const a = snapshot(finalizeFirst.escrow, finalizeFirst.db, finalizeFirst.bountyId);
  const b = snapshot(acceptOnly.escrow, acceptOnly.db, acceptOnly.bountyId);
  assert.deepEqual(b, a, "poke order must not change the outcome");
  assert.equal(b.state, "refunded");
  assert.equal(b.settlement.kind, "unverified");
  assert.equal(b.settlement.workerMillis, 0);
  assert.equal(b.grok.payable, 100); // on-time worker: bond home, no strike, no pay
  assert.equal(b.jill.payable, 100); // escrow back with the poster in full
  expectConserved(acceptOnly.escrow);
});

test("accept race: the self-finalized settlement commits even though the accept throws", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
  tick(2_000);
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /refunded/);
  const rowsAfterSettle = journalRows(db);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "refunded");
  // No door can move it again: the settlement is durable, not rolled back
  // with the refused accept.
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state", /nothing to finalize/);
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /refunded, not awaiting acceptance/);
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "too late" }), "invalid_state", /refunded, not disputable/);
  assert.equal(journalRows(db), rowsAfterSettle, "no door wrote new journal rows");
  expectConserved(escrow);
});

test("accept race: a non-approver's post-deadline accept also self-finalizes (door = keeper just ran)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
  tick(2_000);
  // INSTINCT is not the approver for a human-mode bounty; the state error
  // (existing precedence: state before authorization) now reports the
  // keeper's deterministic outcome instead of racing it.
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: INSTINCT, verifierAttestation: attest() }), "invalid_state", /refunded, not awaiting acceptance/);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "refunded");
  expectConserved(escrow);
});

// --- dispute path ----------------------------------------------------------

test("dispute matrix: dispute on submitted work before the deadline opens (unchanged)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { verifier: INSTINCT, deadlineMs: 3_600_000 });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "plagiarized" });
  assert.ok(dispute.disputeId);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  expectConserved(escrow);
});

test("dispute race: dispute on submitted work after the deadline settles unverified — identical to finalize-first", () => {
  const setup = escrow => {
    const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
    tick(2_000); // past the deadline with no verdict
    return bounty;
  };
  const dispute = (escrow, bounty) => expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "bad work" }), "invalid_state", /refunded, not disputable/);
  const [finalizeFirst, disputeFirst] = compareOrders(setup,
    (escrow, bounty) => {
      assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "refunded");
      dispute(escrow, bounty);
    },
    (escrow, bounty) => dispute(escrow, bounty)); // the dispute is the first poke: it self-finalizes
  const a = snapshot(finalizeFirst.escrow, finalizeFirst.db, finalizeFirst.bountyId);
  const b = snapshot(disputeFirst.escrow, disputeFirst.db, disputeFirst.bountyId);
  assert.deepEqual(b, a, "poke order must not change the outcome");
  assert.equal(b.settlement.kind, "unverified");
  assert.equal(b.codex.payable, 100, "the refused dispute never locked a bond");
  expectConserved(disputeFirst.escrow);
});

test("dispute matrix: dispute on accepted work inside the challenge window opens (unchanged)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { amount: 0.5, verifier: INSTINCT, deadlineMs: 3_600_000 });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
  tick(CHALLENGE_WINDOW_SMALL_MS - 1_000); // still inside the window
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 0.125, grounds: "looks wrong" });
  assert.ok(dispute.disputeId);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  expectConserved(escrow);
});

test("dispute race (issue repro): dispute at challengeEnd+1ms — same end state as finalize-first, and the approval pays out", () => {
  const setup = escrow => {
    const bounty = runToSubmitted(escrow, { amount: 0.5, verifier: INSTINCT, deadlineMs: 3_600_000 });
    escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
    tick(CHALLENGE_WINDOW_SMALL_MS + 1); // challenge window closed 1ms ago
    return bounty;
  };
  const dispute = (escrow, bounty) => expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 0.125, grounds: "too late" }), "invalid_state", /approved, not disputable/);
  const [finalizeFirst, disputeFirst] = compareOrders(setup,
    (escrow, bounty) => {
      assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "approved");
      dispute(escrow, bounty);
      escrow.closeEpoch(ROOM, {});
    },
    (escrow, bounty) => {
      dispute(escrow, bounty); // the dispute is the first poke: it self-finalizes (approves)
      escrow.closeEpoch(ROOM, {});
    });
  const a = snapshot(finalizeFirst.escrow, finalizeFirst.db, finalizeFirst.bountyId);
  const b = snapshot(disputeFirst.escrow, disputeFirst.db, disputeFirst.bountyId);
  assert.deepEqual(b, a, "poke order must not change the outcome");
  assert.equal(b.state, "paid");
  assert.equal(b.settlement.kind, "verified-complete");
  assert.equal(b.grok.payable, 100.495); // bond home + 99% of the award
  assert.equal(b.codex.payable, 100, "the refused dispute never locked a bond");
  expectConserved(disputeFirst.escrow);
});

test("dispute race: dispute at exactly challengeEndsMs is refused (keeper boundary is >=)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { amount: 0.5, verifier: INSTINCT, deadlineMs: 3_600_000 });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
  tick(CHALLENGE_WINDOW_SMALL_MS); // now == challengeEndsMs exactly
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 0.125, grounds: "at the line" }), "invalid_state", /approved, not disputable/);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "approved");
  expectConserved(escrow);
});

// --- epoch door --------------------------------------------------------------

test("epoch door agrees: closeEpoch settles a past-deadline submitted bounty like finalizeBounty", () => {
  const setup = escrow => {
    const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
    tick(2_000); // past the deadline, never verified
    return bounty;
  };
  const [viaFinalize, viaEpoch] = compareOrders(setup,
    (escrow, bounty) => escrow.finalizeBounty(ROOM, bounty.bountyId, {}),
    (escrow, bounty) => {
      const epoch = escrow.closeEpoch(ROOM, {});
      assert.deepEqual(epoch.summary.refunded, [bounty.bountyId]);
    });
  const a = snapshot(viaFinalize.escrow, viaFinalize.db, viaFinalize.bountyId);
  const b = snapshot(viaEpoch.escrow, viaEpoch.db, viaEpoch.bountyId);
  // The epoch path additionally writes an epoch.closed event, which lives
  // in the events table and moves no money, so even the journal counts
  // must match exactly.
  assert.deepEqual(b, a, "epoch close must settle submitted work identically");
  assert.equal(b.settlement.kind, "unverified");
  expectConserved(viaEpoch.escrow);
});

test("epoch door agrees: closeEpoch leaves in-review (pre-deadline) submitted work untouched", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { deadlineMs: 3_600_000 });
  const rowsBefore = journalRows(db);
  const epoch = escrow.closeEpoch(ROOM, {});
  assert.deepEqual(epoch.summary.refunded, []);
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted");
  assert.equal(after.resolution?.settlement ?? null, null);
  assert.equal(journalRows(db), rowsBefore, "no settlement movement for in-review work");
  expectConserved(escrow);
});

// --- pre-existing boundaries, unchanged --------------------------------------

test("boundary unchanged: submitWork at exactly the deadline refuses", () => {
  const { escrow } = makeEscrow();
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(60_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(60_000); // now == deadlineMs
  expectCode(() => escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence }),
    "invalid_state", /submission deadline passed/);
  expectConserved(escrow);
});
