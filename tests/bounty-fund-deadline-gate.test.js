// EA2-009: fundBounty must be refused past the bounty deadline. Before
// the fix, funding a proposed bounty after its deadline succeeded if no
// keeper pass had expired it first (fund-first locked escrow; keeper-first
// expired the bounty to `cancelled` and funding was refused) — fundability
// itself was decided by which actor ran first. One deterministic rule,
// mirroring PR #5500's accept/reject gate (EA-005 / EA2-003): past the
// deadline fundBounty refuses with invalid_state and the keeper's
// settlement (expire-unfunded -> cancelled) stands. The gate carries the
// keeper's own proposed-state snooze exception: a bounty snoozed past its
// deadline may still be funded until the snooze itself expires, exactly
// the interval in which the keeper also leaves it alone.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-fund-deadline-gate";
const JILL = "id:agent/jill"; // poster lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const DEADLINE_MS = 3_600_000; // 1h

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

function postProposed(escrow, { amount = 10 } = {}) {
  const { bounty } = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(DEADLINE_MS) });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("EA2-009: fundBounty past the deadline is refused and locks nothing", () => {
  const { escrow } = makeEscrow();
  const bounty = postProposed(escrow);
  tick(DEADLINE_MS + 3_600_000); // 1h past the deadline, no keeper pass
  expectCode(() => escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }), "invalid_state");
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "proposed");
  assert.equal(bal(escrow, JILL).payable, 100);
  assert.equal(bal(escrow, JILL).locked, 0);
  expectConserved(escrow);
});

test("EA2-009: fundBounty at exactly the deadline is refused (half-open gate)", () => {
  const { escrow } = makeEscrow();
  const bounty = postProposed(escrow);
  tick(DEADLINE_MS); // now == deadlineMs: the keeper settles at now >= deadlineMs
  expectCode(() => escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }), "invalid_state");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "proposed");
  expectConserved(escrow);
});

test("EA2-009: fundBounty 1ms before the deadline still succeeds", () => {
  const { escrow } = makeEscrow();
  const bounty = postProposed(escrow);
  tick(DEADLINE_MS - 1);
  const { bounty: funded } = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  assert.equal(funded.state, "funded");
  assert.equal(bal(escrow, JILL).locked, 10);
  expectConserved(escrow);
});

test("EA2-009: both orders settle identically — keeper expiry stands either way", () => {
  // Keeper-first: the keeper expires the proposed bounty, fund is refused.
  const first = makeEscrow();
  const b1 = postProposed(first.escrow);
  tick(DEADLINE_MS + 1);
  const summary1 = first.escrow.closeEpoch(ROOM, {});
  assert.ok(JSON.stringify(summary1).includes(b1.bountyId) || first.escrow.getBounty(ROOM, b1.bountyId).state === "cancelled");
  assert.equal(first.escrow.getBounty(ROOM, b1.bountyId).state, "cancelled");
  expectCode(() => first.escrow.fundBounty(ROOM, b1.bountyId, { funder: JILL }), "invalid_state");

  // Fund-first attempt: the late fund is refused, then the keeper expires
  // the bounty to the same terminal state with the same balances.
  const second = makeEscrow();
  const b2 = postProposed(second.escrow);
  tick(DEADLINE_MS + 1);
  expectCode(() => second.escrow.fundBounty(ROOM, b2.bountyId, { funder: JILL }), "invalid_state");
  second.escrow.closeEpoch(ROOM, {});
  assert.equal(second.escrow.getBounty(ROOM, b2.bountyId).state, "cancelled");
  assert.equal(bal(second.escrow, JILL).payable, 100);
  assert.equal(bal(second.escrow, JILL).locked, 0);
  expectConserved(first.escrow);
  expectConserved(second.escrow);
});

test("EA2-009: a snoozed proposal may be funded until its snooze expires, then no longer", () => {
  const { escrow } = makeEscrow();
  const bounty = postProposed(escrow);
  // Snooze 2h past the 1h deadline: the keeper leaves snoozed proposals
  // alone until the snooze expires, and funding follows the same rule.
  escrow.snoozeBounty(ROOM, bounty.bountyId, { snoozer: JILL, until: isoFuture(DEADLINE_MS + 7_200_000) });
  tick(DEADLINE_MS + 3_600_000); // past deadline, inside the snooze
  const { bounty: funded } = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  assert.equal(funded.state, "funded");
  expectConserved(escrow);

  const late = makeEscrow();
  const b2 = postProposed(late.escrow);
  late.escrow.snoozeBounty(ROOM, b2.bountyId, { snoozer: JILL, until: isoFuture(DEADLINE_MS + 7_200_000) });
  tick(DEADLINE_MS + 7_200_000); // snooze itself has now expired
  expectCode(() => late.escrow.fundBounty(ROOM, b2.bountyId, { funder: JILL }), "invalid_state");
  assert.equal(late.escrow.getBounty(ROOM, b2.bountyId).state, "proposed");
  expectConserved(late.escrow);
});
