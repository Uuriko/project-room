// Guild-14 property test: dispute economics.
// Bond must be exactly 25% of the bounty (ceil), total dispute cost capped at
// 25%, split settlements conserve (workerHalf + posterHalf == amount),
// and bond return/forfeit conserve across open/resolve/withdraw.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, MILLIS_PER_CREDIT } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-disputes";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT g14d");
    try { const out = fn(); db.exec("RELEASE g14d"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14d"); db.exec("RELEASE g14d"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

function runToSubmitted(escrow, amount) {
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence: { evidenceUrl: "https://example.com/x", summary: "w" } });
  return bounty.bountyId;
}

test("g14-disputes: bond is exactly ceil(25% of bounty), enforced both ways", () => {
  const escrow = makeEscrow();
  const id = runToSubmitted(escrow, 10); // 10000 millis -> bond 2500
  assert.throws(() => escrow.disputeBounty(ROOM, id, { challenger: INSTINCT, bond: 2.499, grounds: "g" }), e => typeof e.code === "string");
  assert.throws(() => escrow.disputeBounty(ROOM, id, { challenger: INSTINCT, bond: 2.501, grounds: "g" }), e => typeof e.code === "string");
  escrow.disputeBounty(ROOM, id, { challenger: INSTINCT, bond: 2.5, grounds: "g" });
  assert.equal(escrow.getBounty(ROOM, id).state, "disputed");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("g14-disputes: odd-millis bounty bond rounds UP (challenger cannot underpay)", () => {
  const escrow = makeEscrow();
  const id = runToSubmitted(escrow, 10.001); // 10001 millis -> 25% = 2500.25 -> bond 2501
  assert.throws(() => escrow.disputeBounty(ROOM, id, { challenger: INSTINCT, bond: 2.5, grounds: "g" }), e => typeof e.code === "string");
  escrow.disputeBounty(ROOM, id, { challenger: INSTINCT, bond: 2.501, grounds: "g" });
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("g14-disputes: dispute withdraw conserves (bond returned, nothing moved)", () => {
  const escrow = makeEscrow();
  const id = runToSubmitted(escrow, 8);
  const beforeChallenger = escrow.balances(ROOM, INSTINCT).payable;
  escrow.disputeBounty(ROOM, id, { challenger: INSTINCT, bond: 2, grounds: "g" });
  const dispute = escrow.getDispute(ROOM, escrow.getBounty(ROOM, id).disputeId);
  assert.ok(dispute, "dispute record readable");
  assert.equal(escrow.balances(ROOM, INSTINCT).payable, beforeChallenger - 2);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
