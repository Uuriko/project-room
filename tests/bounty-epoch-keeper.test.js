// Tests for server/bounty-epoch-keeper.mjs (#3693, #3844): payout epochs
// must progress on their own. Before this keeper, closeEpoch ran only when
// a human or agent remembered to invoke it — twice — so accepted awards
// sat attributed indefinitely with no surface complaining.
//
// Construction mirrors tests/bounty-escrow.test.js: an in-memory
// node:sqlite store double whose transaction() is a SAVEPOINT (the nesting
// shape RoomStore.transaction has in production), a fake clock, and the
// escrow's journal seam (_append) as the poison point for failure tests
// (the seam tests/bounty-escrow-atomicity.test.js established for #3275).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { progressEscrowEpochs, escrowEpochNextDueAt } from "../server/bounty-epoch-keeper.mjs";
import { jobByName, jobEnabled, jobIsDue, jobNextDue } from "../server/jobs.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // verifier lane
const CODEX = "id:agent/codex";     // challenger lane
const LANES = [JILL, GROK, INSTINCT, CODEX, "pool"];
const DAY_MS = 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld(room = ROOM) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(room);
  return { store, db, escrow, room };
}

const bal = (escrow, room, lane) => escrow.balances(room, lane);
const expectConserved = (escrow, room) => {
  const c = escrow.verifyConservation(room);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};
const keeper = (world, room = world.room) =>
  progressEscrowEpochs(world.store, { now: nowMs, escrow: world.escrow });

// Post -> fund -> claim -> submit -> accept in `room` (10 credits, 3-day
// challenge window, deadline far away so only the window matters).
function runToAccepted(world, room = world.room) {
  const bounty = world.escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(30 * DAY_MS) }).bounty;
  world.escrow.fundBounty(room, bounty.bountyId, { funder: JILL });
  world.escrow.claimBounty(room, bounty.bountyId, { claimant: GROK });
  world.escrow.submitWork(room, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  world.escrow.acceptWork(room, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return world.escrow.getBounty(room, bounty.bountyId);
}

test("the stall scenario pays out with zero manual closes, one step per tick", () => {
  const world = makeWorld();
  const { escrow, room } = world;
  const bounty = runToAccepted(world);
  tick(4 * DAY_MS); // 4 days past acceptance; the challenge window is 3
  // The stall, reproduced: still accepted, the award still only attributed
  // (worker payable 99 = genesis minus the locked claim bond).
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "accepted");
  assert.equal(bal(escrow, room, GROK).payable, 99);
  assert.equal(bal(escrow, room, GROK).attributed, 10);

  const first = keeper(world);
  assert.equal(first.due, 1);
  assert.equal(first.approved, 1);
  assert.equal(first.paid, 0, "the sweep never rides the approving pass");
  assert.equal(first.failed, 0);
  assert.equal(first.overdue, 0, "an approved bounty is mid-progression, not stalled");
  // Two-step semantics: approved is not paid, and no money has moved yet.
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "approved");
  assert.equal(bal(escrow, room, GROK).payable, 99);

  const second = keeper(world);
  assert.equal(second.paid, 1);
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "paid");
  assert.equal(bal(escrow, room, GROK).payable, 109.9, "genesis 100 + 9.9 net of the 1% fee");
  assert.equal(bal(escrow, room, GROK).locked, 0, "the claim bond came home");
  expectConserved(escrow, room);
});

test("nothing progresses before its window or deadline", () => {
  const world = makeWorld();
  const { escrow, room } = world;
  const bounty = runToAccepted(world);
  tick(1 * DAY_MS); // challenge window (3 days) still open
  const summary = keeper(world);
  assert.equal(summary.due, 0);
  assert.equal(summary.rooms, 0, "no room is closed early");
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "accepted");
  // The keeper's next wake is the window's end, not the job cadence.
  assert.equal(escrowEpochNextDueAt(world.store, nowMs), nowMs + 2 * DAY_MS);
  expectConserved(escrow, room);
});

test("the automatic path matches manual closes exactly (differential)", () => {
  const world = makeWorld("room-auto");
  const { escrow, store } = world;
  const manualRoom = "room-manual";
  escrow.ensureGenesis(manualRoom);
  const auto = runToAccepted(world, "room-auto");
  const manual = runToAccepted(world, manualRoom);
  tick(4 * DAY_MS);

  escrow.closeEpoch(manualRoom);
  escrow.closeEpoch(manualRoom);
  keeper(world, "room-auto");
  const second = keeper(world, "room-auto");
  assert.equal(second.paid, 1);

  assert.equal(escrow.getBounty("room-auto", auto.bountyId).state, "paid");
  assert.equal(escrow.getBounty(manualRoom, manual.bountyId).state, "paid");
  // Byte-identical balances for every lane, pool included.
  for (const lane of LANES) {
    assert.deepEqual(bal(escrow, "room-auto", lane), bal(escrow, manualRoom, lane), lane);
  }
  // Identical journal movement shape (ids and lot ids differ by room).
  const movements = roomId => store.db.prepare(
    `SELECT account_id, lot_state, amount, kind FROM bounty_journal
     WHERE room_id=? ORDER BY seq`).all(roomId)
    .map(r => [r.account_id, r.lot_state, r.amount, r.kind]);
  assert.deepEqual(movements("room-auto"), movements(manualRoom));
  expectConserved(escrow, "room-auto");
  expectConserved(escrow, manualRoom);
});

test("re-running the keeper over settled state is a no-op", () => {
  const world = makeWorld();
  const { escrow, store, room } = world;
  const bounty = runToAccepted(world);
  tick(4 * DAY_MS);
  keeper(world);
  keeper(world);
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "paid");
  const journalRows = () => store.db.prepare(
    "SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=?").get(room).n;
  const payouts = store.db.prepare(
    "SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' AND amount > 0")
    .get(room, bounty.bountyId).n;
  assert.equal(payouts, 1, "exactly one payout movement, however often the keeper runs");
  const rowsBefore = journalRows();
  const balancesBefore = LANES.map(lane => bal(escrow, room, lane));
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(keeper(world),
      { rooms: 0, due: 0, approved: 0, paid: 0, refunded: 0, released: 0, expired: 0, failed: 0, errors: 0, overdue: 0 });
  }
  assert.equal(journalRows(), rowsBefore, "no duplicate journal rows");
  assert.deepEqual(LANES.map(lane => bal(escrow, room, lane)), balancesBefore);
  expectConserved(escrow, room);
});

test("an unruled dispute times out, releases and pays with no ruling", () => {
  const world = makeWorld();
  const { escrow, room } = world;
  const posted = escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(30 * DAY_MS), verifierId: INSTINCT }).bounty;
  escrow.fundBounty(room, posted.bountyId, { funder: JILL });
  escrow.claimBounty(room, posted.bountyId, { claimant: GROK });
  escrow.submitWork(room, posted.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(room, posted.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  // Disputed inside the challenge window; the decider never rules.
  escrow.disputeBounty(room, posted.bountyId, { challenger: CODEX, bond: 2.5, grounds: "looks wrong" });
  assert.equal(escrow.getBounty(room, posted.bountyId).state, "disputed");

  tick(15 * DAY_MS); // past the 14-day dispute timeout
  const first = keeper(world);
  assert.equal(first.released, 1, "the timeout default releases the award");
  assert.equal(escrow.getBounty(room, posted.bountyId).state, "approved");
  const second = keeper(world);
  assert.equal(second.paid, 1);
  assert.equal(escrow.getBounty(room, posted.bountyId).state, "paid");
  assert.equal(bal(escrow, room, GROK).payable, 109.9);
  expectConserved(escrow, room);
});

test("deadline refunds and unfunded expiry run on their own", () => {
  const world = makeWorld();
  const { escrow, room } = world;
  const funded = escrow.postBounty(room,
    { poster: JILL, title: "F", criteria: "C", amount: 10, deadline: isoFuture(3600_000) }).bounty;
  escrow.fundBounty(room, funded.bountyId, { funder: JILL });
  const unfunded = escrow.postBounty(room,
    { poster: JILL, title: "U", criteria: "C", amount: 5, deadline: isoFuture(3600_000) }).bounty;
  assert.equal(bal(escrow, room, JILL).payable, 90, "the funded award is locked");
  tick(2 * 3600_000); // both deadlines pass with no claim, no submission
  const summary = keeper(world);
  assert.equal(summary.refunded, 1);
  assert.equal(summary.expired, 1);
  assert.equal(escrow.getBounty(room, funded.bountyId).state, "refunded");
  assert.equal(escrow.getBounty(room, unfunded.bountyId).state, "cancelled");
  assert.equal(bal(escrow, room, JILL).payable, 100, "the refund returned the award in full");
  expectConserved(escrow, room);
});

test("a poisoned bounty fails alone: the rest progress and health counts the stall", () => {
  const world = makeWorld();
  const { escrow, room } = world;
  const poisoned = runToAccepted(world);
  const healthy = runToAccepted(world);
  tick(4 * DAY_MS);
  // Poison: every journal append for the one bounty throws (the #3275 seam).
  const original = escrow._append.bind(escrow);
  escrow._append = args => {
    if (args.bountyId === poisoned.bountyId) throw new Error("injected journal append failure");
    return original(args);
  };
  const first = keeper(world);
  assert.equal(first.failed, 1, "the poisoned bounty is recorded, not swallowed");
  assert.equal(first.errors, 1, "the tick reports failure so job health goes red");
  assert.equal(first.approved, 1, "the healthy bounty still progressed");
  assert.equal(first.overdue, 1, "the stalled bounty stays countable from the summary");
  assert.equal(escrow.getBounty(room, poisoned.bountyId).state, "accepted");
  assert.equal(escrow.getBounty(room, healthy.bountyId).state, "approved");
  expectConserved(escrow, room);

  escrow._append = original;
  const second = keeper(world);
  assert.equal(second.failed, 0);
  assert.equal(second.overdue, 0);
  keeper(world);
  assert.equal(escrow.getBounty(room, poisoned.bountyId).state, "paid");
  assert.equal(escrow.getBounty(room, healthy.bountyId).state, "paid");
  expectConserved(escrow, room);
});

test("the escrow-epochs job is registered, gated and scheduled by the escrow clock", async () => {
  const world = makeWorld();
  const { escrow, store, room } = world;
  const job = jobByName("escrow-epochs");
  assert.ok(job, "job registered");
  assert.equal(job.cadenceMs, 60_000);
  assert.deepEqual([...job.runtimes].sort(), ["node", "worker"]);

  // A store whose escrow tables exist but hold no bounty: the keeper
  // stands down and schedules nothing.
  assert.equal(jobEnabled(job, {}, store), false);
  assert.equal(jobNextDue(job, store, nowMs), null);

  // A proposed bounty schedules its own expiry, not the cadence.
  const posted = escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(2 * 3600_000) }).bounty;
  assert.equal(jobEnabled(job, {}, store), true);
  assert.equal(jobNextDue(job, store, nowMs), nowMs + 2 * 3600_000);
  assert.equal(jobIsDue(job, store, nowMs, undefined), false);
  assert.equal(jobIsDue(job, store, nowMs + 2 * 3600_000, undefined), true);

  // The registered run path drives the real keeper: an accepted bounty
  // past its window is approved by the job, then paid by the next tick.
  const accepted = runToAccepted(world);
  store.bountyEscrow = escrow; // the production store wiring (store.mjs)
  tick(4 * DAY_MS);
  const first = await job.run(store, { now: () => nowMs });
  assert.equal(first.approved, 1);
  assert.ok(Object.values(first).every(value => typeof value === "number"),
    "the summary is numbers-only, so the heartbeat keeps it verbatim");
  // The long-deadline proposed bounty expired in the same pass; the poster
  // was refunded nothing (it never funded) and nothing else moved.
  assert.equal(escrow.getBounty(room, posted.bountyId).state, "cancelled");
  const second = await job.run(store, { now: () => nowMs });
  assert.equal(second.paid, 1);
  assert.equal(escrow.getBounty(room, accepted.bountyId).state, "paid");
  expectConserved(escrow, room);
});
