// Guild-14 regression: disputing a bounty in a non-disputable state must be
// rejected. Mutant m3-dispute-state-widen (replacing the
// submitted|accepted state check with `check(true, ...)`) survived the
// existing suite: nothing pinned the dispute state gate. Fails on the mutant,
// passes on the real code.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-dispute-gate";
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

const expectCode = (fn, code) => {
  try { fn(); } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e && e.code}: ${e && e.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

function runToPaid(escrow, amount) {
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence: { evidenceUrl: "https://example.com/x", summary: "w" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "ok", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  return bounty.bountyId;
}

test("g14-reg-dispute-gate: dispute rejected in non-disputable states", () => {
  const escrow = makeEscrow();
  tick(60_000);
  // proposed: no submission to dispute
  const b1 = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  expectCode(() => escrow.disputeBounty(ROOM, b1.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "g" }), "invalid_state");
  // funded but not claimed/submitted
  escrow.fundBounty(ROOM, b1.bountyId, { funder: JILL });
  expectCode(() => escrow.disputeBounty(ROOM, b1.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "g" }), "invalid_state");
  // claimed but not submitted
  escrow.claimBounty(ROOM, b1.bountyId, { claimant: GROK });
  expectCode(() => escrow.disputeBounty(ROOM, b1.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "g" }), "invalid_state");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("g14-reg-dispute-gate: dispute rejected on a paid bounty", () => {
  const escrow = makeEscrow();
  tick(60_000);
  const id = runToPaid(escrow, 10);
  assert.equal(escrow.getBounty(ROOM, id).state, "paid");
  expectCode(() => escrow.disputeBounty(ROOM, id, { challenger: INSTINCT, bond: 2.5, grounds: "g" }), "invalid_state");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
