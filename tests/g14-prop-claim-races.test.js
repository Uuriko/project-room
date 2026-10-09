// Guild-14 property test: concurrent settlement races (interleaved attempts).
// Many lanes try to claim the same bounty: exactly one wins, the rest get an
// error, and conservation holds. Double-finalize is rejected; epoch closes
// are idempotent under interleaving.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-g14-races";
const JILL = "id:agent/jill";
let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const LANES = ["id:agent/grokbot", "id:agent/instinct", "id:agent/codex"];

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT g14r");
    try { const out = fn(); db.exec("RELEASE g14r"); return out; }
    catch (e) { db.exec("ROLLBACK TO g14r"); db.exec("RELEASE g14r"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

test("g14-races: N claimants, exactly one claim wins", () => {
  for (let i = 0; i < 10; i++) {
    const escrow = makeEscrow();
    tick(60_000);
    const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
    escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
    let wins = 0;
    for (const lane of [...LANES, ...LANES]) { // interleaved retry order
      try { escrow.claimBounty(ROOM, bounty.bountyId, { claimant: lane }); wins++; }
      catch (e) { assert.ok(typeof e.code === "string"); }
    }
    assert.equal(wins, 1, `expected exactly one winning claim, got ${wins}`);
    assert.equal(escrow.verifyConservation(ROOM).ok, true);
  }
});

test("g14-races: double finalize / double epoch close cannot double-pay", () => {
  const escrow = makeEscrow();
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 20, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: LANES[0] });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: LANES[0], evidence: { evidenceUrl: "https://example.com/x", summary: "w" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "ok", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  tick(3 * 24 * 3600 * 1000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.throws(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), e => typeof e.code === "string");
  tick(3 * 24 * 3600 * 1000 + 1);
  const before = escrow.balances(ROOM, LANES[0]).payable;
  escrow.closeEpoch(ROOM, {});
  escrow.closeEpoch(ROOM, {});
  escrow.closeEpoch(ROOM, {});
  const delta = escrow.balances(ROOM, LANES[0]).payable - before;
  assert.ok(Math.abs(delta - 20.8) < 1e-9, `worker must be paid exactly once (20 - 1% fee + 1-credit bond returned), got ${delta}`);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
