// Guild-14 regression: the 1% room-pool fee must FLOOR, never ceiling.
// Mutant m1-fee-ceil (Math.floor -> Math.ceil in _sweep) survived the existing
// suite: no test pinned exact fee rounding. Amount 10.001 credits = 10001
// millis: fee = floor(10001/100) = 100 millis (0.1 credits), NOT 101.
// Fails on the mutant, passes on the real code.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, MILLIS_PER_CREDIT } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-fee-floor";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT g14f");
    try { const out = fn(); db.exec("RELEASE g14f"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14f"); db.exec("RELEASE g14f"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

test("g14-reg-fee-floor: fee floors on non-divisible millis amounts", () => {
  const escrow = makeEscrow();
  const gross = 10001; // 10.001 credits
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10.001, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence: { evidenceUrl: "https://example.com/x", summary: "w" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "ok", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  const workerBefore = 100; // genesis payable
  const workerBal = escrow.balances(ROOM, GROK).payable;
  const poolBal = escrow.balances(ROOM, "pool").payable;
  const expectedFee = Math.floor(gross / 100) / MILLIS_PER_CREDIT; // 0.1
  const expectedNet = (gross - Math.floor(gross / 100)) / MILLIS_PER_CREDIT; // 9.901
  assert.equal(poolBal, expectedFee, `pool fee must be floor(1%) = ${expectedFee}, got ${poolBal}`);
  assert.equal(workerBal, workerBefore + expectedNet, `worker net must be ${expectedNet}, got ${workerBal - workerBefore}`);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
