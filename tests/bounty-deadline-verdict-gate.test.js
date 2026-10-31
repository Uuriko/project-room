// EA-005 / EA2-003: acceptWork and rejectWork must be refused past the
// bounty deadline. Before the fix, whether late-reviewed work was paid
// (accept) or settled "failed" with a forfeited bond + flake strike
// (reject) instead of the keeper's "unverified" free-miss settlement was
// decided by which actor ran first. One deterministic rule: past the
// deadline both verdict paths refuse with invalid_state (the same
// refusal idiom claimBounty/submitWork already use), and the keeper's
// unverified settlement then stands undisputed in both orders.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-deadline-gate";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const DEADLINE_MS = 3_600_000; // 1h, per the EA-005/EA2-003 probes

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
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const flakeRows = (db, lane, bountyId) => db.prepare(
  "SELECT COUNT(*) AS c FROM bounty_flakes WHERE room_id=? AND lane=? AND bounty_id=?").get(ROOM, lane, bountyId).c;

const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

// Post -> fund -> claim -> submit, all on time (deadline = now + 1h).
function runToSubmitted(escrow, { amount = 10 } = {}) {
  const { bounty } = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(DEADLINE_MS) });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// The keeper's unverified settlement shape, asserted identically in both orders.
function assertUnverifiedSettlement(escrow, db, bountyId) {
  const settled = escrow.getBounty(ROOM, bountyId);
  assert.equal(settled.state, "refunded");
  assert.equal(settled.resolution.settlement.kind, "unverified");
  assert.equal(settled.resolution.settlement.workerMillis, 0);
  assert.equal(settled.resolution.settlement.refundMillis, 10000);
  assert.equal(bal(escrow, JILL).payable, 100);
  // Submitted on time: bond returns, no flake strike.
  assert.equal(bal(escrow, GROK).payable, 100);
  assert.equal(bal(escrow, GROK).locked, 0);
  assert.equal(bal(escrow, "pool").payable, 0);
  assert.equal(flakeRows(db, GROK, bountyId), 0);
  expectConserved(escrow);
}

test("EA-005: acceptWork past the deadline is refused and moves nothing", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  tick(DEADLINE_MS + 3_600_000); // 1h past the deadline, no keeper pass
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest() }), "invalid_state");
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted", "late accept must not attribute the award");
  assert.equal(bal(escrow, GROK).attributed ?? 0, 0);
  expectConserved(escrow);
});

test("EA-005 both orders: accept-attempt-then-keeper and keeper-then-accept settle identically (unverified)", () => {
  // Order A: late accept attempted first (refused), keeper settles after.
  {
    const { escrow, db } = makeEscrow();
    const bounty = runToSubmitted(escrow);
    tick(DEADLINE_MS + 1);
    expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
      { acceptor: JILL, verifierAttestation: attest() }), "invalid_state");
    const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
    assert.equal(fin.action, "refunded");
    assertUnverifiedSettlement(escrow, db, bounty.bountyId);
  }
  // Order B: keeper settles first, late accept attempted after.
  {
    const { escrow, db } = makeEscrow();
    const bounty = runToSubmitted(escrow);
    tick(DEADLINE_MS + 1);
    const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
    assert.equal(fin.action, "refunded");
    expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
      { acceptor: JILL, verifierAttestation: attest() }), "invalid_state");
    assertUnverifiedSettlement(escrow, db, bounty.bountyId);
  }
});

test("EA2-003: rejectWork past the deadline is refused — no failed settlement, no bond forfeit, no strike", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  tick(DEADLINE_MS + 3_600_000); // 1h past the deadline, no keeper pass
  expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId,
    { rejector: JILL, reason: "did not meet the criteria" }), "invalid_state");
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted", "late reject must not settle the bounty");
  assert.equal(after.resolution?.settlement ?? null, null);
  assert.equal(flakeRows(db, GROK, bounty.bountyId), 0);
  assert.equal(bal(escrow, GROK).locked, 1, "claim bond still locked, not forfeited");
  expectConserved(escrow);
});

test("EA2-003 both orders: reject-attempt-then-keeper and keeper-then-reject settle identically (unverified)", () => {
  // Order A: late reject attempted first (refused), keeper settles after.
  {
    const { escrow, db } = makeEscrow();
    const bounty = runToSubmitted(escrow);
    tick(DEADLINE_MS + 1);
    expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId,
      { rejector: JILL, reason: "bad" }), "invalid_state");
    const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
    assert.equal(fin.action, "refunded");
    assertUnverifiedSettlement(escrow, db, bounty.bountyId);
  }
  // Order B: keeper settles unverified first; a later reject is REFUSED,
  // not a silent replay of the unverified settlement.
  {
    const { escrow, db } = makeEscrow();
    const bounty = runToSubmitted(escrow);
    tick(DEADLINE_MS + 1);
    const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
    assert.equal(fin.action, "refunded");
    expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId,
      { rejector: JILL, reason: "bad" }), "invalid_state");
    assertUnverifiedSettlement(escrow, db, bounty.bountyId);
  }
});

test("boundary: verdicts are refused at exactly the deadline and still work 1ms before it", () => {
  // At the deadline instant the keeper already settles (now >= deadlineMs),
  // so both verdict paths must refuse there too — the window is half-open.
  {
    const { escrow } = makeEscrow();
    const bounty = runToSubmitted(escrow);
    tick(DEADLINE_MS); // now == deadlineMs
    expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
      { acceptor: JILL, verifierAttestation: attest() }), "invalid_state");
    expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId,
      { rejector: JILL, reason: "bad" }), "invalid_state");
  }
  // 1ms before the deadline the gate must not over-refuse.
  {
    const { escrow } = makeEscrow();
    const bounty = runToSubmitted(escrow);
    tick(DEADLINE_MS - 1);
    const { bounty: accepted } = escrow.acceptWork(ROOM, bounty.bountyId,
      { acceptor: JILL, verifierAttestation: attest() });
    assert.equal(accepted.state, "accepted");
    expectConserved(escrow);
  }
  {
    const { escrow } = makeEscrow();
    const bounty = runToSubmitted(escrow);
    tick(DEADLINE_MS - 1);
    const { settlement } = escrow.rejectWork(ROOM, bounty.bountyId,
      { rejector: JILL, reason: "bad" });
    assert.equal(settlement.kind, "failed");
    expectConserved(escrow);
  }
});
