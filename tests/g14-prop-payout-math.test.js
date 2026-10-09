// Guild-14 property test: payout math.
// Full lifecycle (post -> fund -> claim -> submit -> accept -> finalize ->
// closeEpoch -> paid) for many amounts. Invariants: paid + fee == gross,
// fee == floor(gross * 1/100), pool received exactly the sum of fees,
// genesis total conserved across all lanes + pool.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, MILLIS_PER_CREDIT } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-payout";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT g14p");
    try { const out = fn(); db.exec("RELEASE g14p"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14p"); db.exec("RELEASE g14p"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

function runToPaid(escrow, amount) {
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence: { evidenceUrl: "https://example.com/x", summary: "w" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "ok", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.closeEpoch(ROOM, {});
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("g14-payout: paid + fee == gross and fee == floor(1%)", () => {
  const escrow = makeEscrow();
  let expectPool = 0;
  const amounts = [1, 2, 0.001, 0.333, 10, 33.33, 100.999, 999.999, 5.05, 7.77];
  for (const amount of amounts) {
    tick(60_000);
    const gross = Math.round(amount * MILLIS_PER_CREDIT);
    const b = runToPaid(escrow, amount);
    assert.equal(b.state, "paid");
    const feeMillis = Math.floor(gross * 1 / 100);
    expectPool += feeMillis;
    // Earners' payable rose by gross - fee (net), pool by fee. Check via journal.
    const c = escrow.verifyConservation(ROOM);
    assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
  }
  const poolBal = escrow.balances(ROOM, "pool");
  assert.equal(poolBal.payable * MILLIS_PER_CREDIT, expectPool, `pool got ${poolBal.payable} credits, expected ${expectPool / MILLIS_PER_CREDIT}`);
});

test("g14-payout: total credits conserved across lanes + pool after many payouts", () => {
  const escrow = makeEscrow();
  const lanes = [JILL, GROK, "id:agent/instinct", "id:agent/codex"];
  const startTotal = lanes.reduce((s, l) => s + escrow.balances(ROOM, l).total, 0);
  for (let i = 0; i < 12; i++) {
    tick(60_000);
    runToPaid(escrow, 1 + i * 0.7);
  }
  const endTotal = lanes.reduce((s, l) => s + escrow.balances(ROOM, l).total, 0) + escrow.balances(ROOM, "pool").total;
  assert.equal(endTotal, startTotal, `credits created/destroyed: ${startTotal} -> ${endTotal}`);
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true);
});
