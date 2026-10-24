// Regression tests for #3693: the per-bounty finalize door must pay an
// approved bounty. Before the fix, _keeperPass had no approved branch, so
// finalizeBounty threw invalid_state ("nothing to finalize") on exactly
// the state its MCP tool copy (client/bounty-tools.mjs bounty_finalize)
// and docs/BOUNTY-MCP-TOOLS.md promise it pays out — only closeEpoch
// could sweep an approved bounty. PR #3865 automated closeEpoch but left
// the per-bounty / agent door unable to pay. The door now reuses the
// epoch path's _sweep settlement; these tests pin the door end-to-end,
// its exactly-once behaviour, and byte-parity with the epoch door.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner } from "../server/bounty-receipts.mjs";

// The operator test key from tests/bounty-receipts.test.js (the published
// dasha-receipt/1 reference vector seed), so signed receipts can issue.
const TEST_SEED = "9d61b19deffd5a60ba844af492ec2af44449c5697b326919703bac031cae7f60";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
const LANES = [JILL, GROK, "pool"];
const DAY_MS = 24 * 3600 * 1000;
const CHALLENGE_WINDOW_MS = 3 * DAY_MS; // >= 1 credit bounties

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld(room = ROOM, { signed = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const opts = { now: () => nowMs, allowLegacyStringLanes: true };
  if (signed) opts.receipts = createReceiptSigner({ seedHex: TEST_SEED, ref: "test-operator" });
  const escrow = new BountyEscrow(store, opts);
  escrow.ensureGenesis(room);
  return { escrow, db, store, room };
}

const bal = (escrow, room, lane) => escrow.balances(room, lane);
const expectConserved = (escrow, room) => {
  const c = escrow.verifyConservation(room);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const journalRows = (db, room) => db.prepare(
  "SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=?").get(room).n;
const payoutRows = (db, room, bountyId) => db.prepare(
  "SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' AND amount > 0"
).get(room, bountyId).n;

// Post -> fund -> claim -> submit -> accept in `room` (10 credits, 3-day
// challenge window, deadline far away so only the window matters).
function runToAccepted(world, room = world.room) {
  const { escrow } = world;
  const bounty = escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(30 * DAY_MS) }).bounty;
  escrow.fundBounty(room, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(room, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(room, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(room, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(room, bounty.bountyId);
}

test("finalize pays an approved bounty through the per-bounty door, end to end (#3693)", () => {
  const world = makeWorld(ROOM, { signed: true });
  const { escrow, db, room } = world;
  const bounty = runToAccepted(world);

  // The challenge-window rule is unchanged: nothing is due while the
  // window is open, and the door still refuses.
  expectCode(() => escrow.finalizeBounty(room, bounty.bountyId, { caller: GROK }), "invalid_state");
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "accepted");

  tick(CHALLENGE_WINDOW_MS + 1);
  // Step one of the two-step close: accepted -> approved, no money moves.
  const fin1 = escrow.finalizeBounty(room, bounty.bountyId, { caller: GROK });
  assert.equal(fin1.action, "approved");
  assert.equal(fin1.bounty.state, "approved");
  assert.equal(bal(escrow, room, GROK).payable, 99, "approval alone pays nothing");
  assert.equal(bal(escrow, room, GROK).approved, 10);

  // Step two — the residual #3693 gap: the same door must now pay the
  // approved award, exactly as the bounty_finalize copy promises.
  const fin2 = escrow.finalizeBounty(room, bounty.bountyId, { caller: GROK });
  assert.equal(fin2.action, "paid");
  assert.equal(fin2.receipt.kind, "finalize");
  assert.equal(fin2.receipt.action, "paid");
  assert.equal(fin2.receipt.signed.length, 1, "the payout carries its signed receipt");
  assert.equal(fin2.receipt.signed[0].type, "payout-released");
  assert.equal(fin2.receipt.signed[0].payload.netAmountMillis, "9900");
  assert.equal(fin2.receipt.signed[0].payload.feeAmountMillis, "100");
  assert.equal(fin2.receipt.signed[0].payload.grossAmountMillis, "10000");
  assert.equal(fin2.receipt.signed[0].payload.paidTo, GROK);
  const paid = escrow.getBounty(room, bounty.bountyId);
  assert.equal(paid.state, "paid");
  assert.equal(paid.group, "paid");
  assert.equal(paid.resolution.settlement.kind, "verified-complete");
  assert.equal(paid.resolution.settlement.workerMillis, 9900);
  // Worker: genesis 100 - 1 claim bond + 9.9 net of the 1% fee + bond home.
  assert.equal(bal(escrow, room, GROK).payable, 109.9);
  assert.equal(bal(escrow, room, GROK).approved, 0);
  assert.equal(bal(escrow, room, GROK).locked, 0, "the claim bond came home");
  assert.equal(bal(escrow, room, "pool").payable, 0.1, "1% room-pool fee");
  assert.equal(payoutRows(db, room, bounty.bountyId), 1, "exactly one payout journal movement");
  expectConserved(escrow, room);
});

test("paying through the door is exactly-once: later finalize and epoch closes move nothing", () => {
  const world = makeWorld();
  const { escrow, db, room } = world;
  const bounty = runToAccepted(world);
  tick(CHALLENGE_WINDOW_MS + 1);
  escrow.finalizeBounty(room, bounty.bountyId, {});
  escrow.finalizeBounty(room, bounty.bountyId, {});
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "paid");

  const rowsBefore = journalRows(db, room);
  const balancesBefore = LANES.map(lane => bal(escrow, room, lane));
  // A paid bounty has nothing left to finalize...
  expectCode(() => escrow.finalizeBounty(room, bounty.bountyId, {}), "invalid_state");
  // ...and the epoch door cannot pay it a second time either.
  const epoch = escrow.closeEpoch(room, {});
  assert.deepEqual(epoch.summary.swept, []);
  assert.equal(journalRows(db, room), rowsBefore, "no duplicate journal rows");
  assert.deepEqual(LANES.map(lane => bal(escrow, room, lane)), balancesBefore);
  assert.equal(payoutRows(db, room, bounty.bountyId), 1);
  expectConserved(escrow, room);
});

test("the per-bounty door and the epoch door settle an approved bounty identically", () => {
  const doorWorld = makeWorld("room-door");
  const epochWorld = makeWorld("room-epoch");
  const doorBounty = runToAccepted(doorWorld, "room-door");
  const epochBounty = runToAccepted(epochWorld, "room-epoch");
  tick(CHALLENGE_WINDOW_MS + 1);

  // Same two-step close, one through finalizeBounty only, one through
  // closeEpoch only (the manual double invocation the keeper automates).
  doorWorld.escrow.finalizeBounty("room-door", doorBounty.bountyId, {});
  doorWorld.escrow.finalizeBounty("room-door", doorBounty.bountyId, {});
  epochWorld.escrow.closeEpoch("room-epoch", {});
  epochWorld.escrow.closeEpoch("room-epoch", {});

  assert.equal(doorWorld.escrow.getBounty("room-door", doorBounty.bountyId).state, "paid");
  assert.equal(epochWorld.escrow.getBounty("room-epoch", epochBounty.bountyId).state, "paid");
  for (const lane of LANES) {
    assert.deepEqual(bal(doorWorld.escrow, "room-door", lane),
      bal(epochWorld.escrow, "room-epoch", lane), lane);
  }
  const movements = (world, room) => world.db.prepare(
    `SELECT account_id, lot_state, amount, kind FROM bounty_journal
     WHERE room_id=? ORDER BY seq`).all(room)
    .map(r => [r.account_id, r.lot_state, r.amount, r.kind]);
  assert.deepEqual(movements(doorWorld, "room-door"), movements(epochWorld, "room-epoch"),
    "identical journal movement shape through either door");
  expectConserved(doorWorld.escrow, "room-door");
  expectConserved(epochWorld.escrow, "room-epoch");
});
