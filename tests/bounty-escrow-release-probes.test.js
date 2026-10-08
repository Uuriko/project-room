// QA200-MUT-17: escrow-release mutation probes (John's 200-agent QA wave).
//
// Probe A found the double-entry netting in _approvedMillis unpinned: a
// gross-only regression (counting credits while ignoring the sweep debit)
// keeps the entire existing suite green while silently defeating the
// double-pay backstop. These tests pin the invariant.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-release-probes";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // verifier lane
const CODEX = "id:agent/codex";     // challenger lane

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
const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;

// Post -> fund -> claim -> submit -> accept.
function runToAccepted(escrow, { amount = 10, verifier = null } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// Drives a bounty all the way to payout and returns the snapshot.
function runToPaid(escrow, { amount = 0.5 } = {}) {
  const bounty = runToAccepted(escrow, { amount });
  tick(24 * 3_600_000 + 1); // micro-bounty challenge window passes
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: GROK });
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch.summary.swept, [bounty.bountyId]);
  return bounty.bountyId;
}

test("double-pay backstop: swept lots net to zero, so a re-sweep finds nothing to pay", () => {
  const { escrow } = makeEscrow();
  const bountyId = runToPaid(escrow);
  // The sweep debit nets the approved credit: _approvedMillis is 0, not the
  // gross 500 millis. A gross-only regression here would silently re-arm the
  // payout (the second-layer guard is the paid state transition, which the
  // existing sweep test pins; this pins the journal layer underneath).
  assert.equal(escrow._approvedMillis(ROOM, GROK, bountyId), 0,
    "approved lots must net to zero after the sweep debit");
  expectConserved(escrow);
});

test("re-running the epoch after payout is a no-op: no second release, balances untouched", () => {
  const { escrow } = makeEscrow();
  const bountyId = runToPaid(escrow);
  const after1 = { grok: bal(escrow, GROK), pool: bal(escrow, "pool"), jill: bal(escrow, JILL) };
  const epoch2 = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch2.summary.swept, [], "second epoch sweeps nothing");
  assert.deepEqual(epoch2.summary.paid, [], "second epoch pays nothing");
  assert.deepEqual(bal(escrow, GROK), after1.grok, "worker balance unchanged by the second epoch");
  assert.deepEqual(bal(escrow, "pool"), after1.pool, "pool balance unchanged by the second epoch");
  assert.deepEqual(bal(escrow, JILL), after1.jill, "poster balance unchanged by the second epoch");
  assert.equal(escrow.getBounty(ROOM, bountyId).state, "paid");
  expectConserved(escrow);
});

test("payout credits the claimant's ledger account and names them on the paid event", () => {
  const { escrow, db } = makeEscrow();
  const bountyId = runToPaid(escrow);
  const credit = db.prepare(
    "SELECT account_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' AND amount>0")
    .get(ROOM, bountyId);
  assert.equal(credit.account_id, GROK, "payout credit lands on the claimant, never another lane");
  const paidEvent = escrow.listEvents(ROOM).find(e => e.type === "bounty.paid");
  assert.equal(paidEvent.data.earner, GROK, "paid event names the claimant as earner");
  expectConserved(escrow);
});

test("a disputed bounty cannot be swept or paid while the dispute is open", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 4, verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 1, grounds: "meh" });
  tick(24 * 3_600_000 + 1); // challenge window passes DURING the open dispute
  let code = null;
  try { escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: GROK }); }
  catch (error) { code = error.code; }
  assert.equal(code, "invalid_state", "finalize on an open dispute is blocked");
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch.summary.swept, [], "no sweep while disputed");
  assert.deepEqual(epoch.summary.paid, [], "no payout while disputed");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  expectConserved(escrow);
});
