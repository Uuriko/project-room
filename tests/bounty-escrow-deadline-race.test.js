// Regression tests for #3591, manifestation 1 only (accept-vs-finalize):
// a submitted bounty's deadline is also the end of its review window, but
// acceptWork never consulted it, so a post-deadline accept raced a
// permissionless finalizeBounty for the same facts and poke order decided
// the ledger. The fix is the issue's Option 3 (clock check at the entry
// point): acceptWork refuses at/after deadlineMs with the same
// `invalid_state` check claimBounty and submitWork already use. The check
// moves no money — settlement stays with the keeper doors
// (finalizeBounty / closeEpoch) — it only makes the boundary
// deterministic: post-deadline accepts always lose.
//
// Salvaged from PR #3645's race test file (its accept-scenario rows); the
// dispute and closeEpoch rows are dropped here because main now pins
// those boundaries elsewhere (disputeBounty is accepted-only with a
// challenge-close refusal; closeEpoch includes 'submitted' — see
// tests/bounty-epoch-keeper.test.js). Expectations are adapted to
// Option 3 semantics: a refused post-deadline accept writes nothing and
// settles nothing; the keeper door that runs afterwards produces exactly
// the finalize-first end state.
//
// Scenario matrix (submit timing x entry-point ordering):
//   in-window accept succeeds (unchanged); accept at deadline-1ms
//   succeeds; accept at/past the deadline is refused and writes nothing —
//   once the keeper door runs, the end state is identical to
//   finalize-first (state, settlement, balances, journal size).
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

test("accept matrix: accept at deadline-1ms succeeds; at the deadline it is refused and settles nothing", () => {
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
    const { escrow, db } = makeEscrow();
    const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
    tick(1_000); // now == deadline exactly
    const rowsBefore = journalRows(db);
    expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
      { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /acceptance deadline passed/);
    // Option 3 moves no money in acceptWork: the bounty is still the
    // keeper's to settle, untouched by the refused accept.
    const after = escrow.getBounty(ROOM, bounty.bountyId);
    assert.equal(after.state, "submitted");
    assert.equal(after.resolution?.settlement ?? null, null);
    assert.equal(journalRows(db), rowsBefore, "a refused accept writes no journal rows");
    expectConserved(escrow);
  }
});

test("accept race (issue repro): submitted at deadline-1s, accept at deadline+1s — same end state as finalize-first", () => {
  const setup = escrow => {
    const bounty = runToSubmitted(escrow, { submitTick: 59_000 }); // on-time submit
    tick(2_000); // deadline + 1s: the review window (deadline - submitTime) was 1s
    return bounty;
  };
  const [finalizeFirst, acceptFirst] = compareOrders(setup,
    (escrow, bounty) => { // keeper pokes first
      const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
      assert.equal(fin.action, "refunded");
      expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
        { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /refunded, not awaiting acceptance/);
    },
    (escrow, bounty) => { // the accept is the first poke: it loses at the
      // deadline, then the keeper settles exactly as in the other order.
      expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
        { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /acceptance deadline passed/);
      const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
      assert.equal(fin.action, "refunded");
    });
  const a = snapshot(finalizeFirst.escrow, finalizeFirst.db, finalizeFirst.bountyId);
  const b = snapshot(acceptFirst.escrow, acceptFirst.db, acceptFirst.bountyId);
  assert.deepEqual(b, a, "poke order must not change the outcome");
  assert.equal(b.state, "refunded");
  assert.equal(b.settlement.kind, "unverified");
  assert.equal(b.settlement.workerMillis, 0);
  assert.equal(b.grok.payable, 100); // on-time worker: bond home, no strike, no pay
  assert.equal(b.jill.payable, 100); // escrow back with the poster in full
  expectConserved(acceptFirst.escrow);
});

test("accept race: after the keeper settles, no door can move the bounty again", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
  tick(2_000);
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /acceptance deadline passed/);
  assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "refunded");
  const rowsAfterSettle = journalRows(db);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "refunded");
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state", /nothing to finalize/);
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() }), "invalid_state", /refunded, not awaiting acceptance/);
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "too late" }), "invalid_state", /refunded, not disputable/);
  assert.equal(journalRows(db), rowsAfterSettle, "no door wrote new journal rows");
  expectConserved(escrow);
});

test("accept race: a non-approver's post-deadline accept is refused on authorization and settles nothing", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { submitTick: 59_000 });
  tick(2_000);
  // INSTINCT is not the approver for a human-mode bounty. Authorization
  // keeps its existing precedence over the deadline check (the same
  // ordering claimBounty / submitWork use), and the refused attempt is
  // not a settlement door: the bounty stays the keeper's to settle.
  const rowsBefore = journalRows(db);
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: INSTINCT, verifierAttestation: attest() }), "not_authorized");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  assert.equal(journalRows(db), rowsBefore, "a refused accept writes no journal rows");
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
