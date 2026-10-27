// CURE-CLOCK-UNIFY (money-core deep-dive S2 + S5): one `now` per keeper
// tick, threaded from the due-scan through closeEpoch, plus an assertion
// that the production clock sources are the same source.
//
// Before the cure, progressEscrowEpochs fixed `now` at entry for its
// scan but closeEpoch re-read the escrow's live clock (store.mjs's
// `now: () => this.now()`), and production wired three independently
// sourced clocks (jobs enabled, jobs run, store/escrow) with no
// equality assertion:
// - S2 (c4-exec-epoch-stamp iv-a): a lot becoming due mid-scan was
//   approved same-tick while the summary reported due=2 / approved=3.
// - S5 (c7-exec-clock-edges iv-b): scan now vs escrow clock divergence
//   split settlement in both directions (due-but-unactionable, and
//   actionable-but-unscanned).
//
// Harness mirrors tests/bounty-epoch-keeper.test.js: in-memory
// node:sqlite store double, SAVEPOINT transactions, injected clock.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import {
  progressEscrowEpochs,
  assertUnifiedEscrowClocks,
  ESCROW_CLOCK_DIVERGENCE_TOLERANCE_MS,
} from "../server/bounty-epoch-keeper.mjs";
import { jobByName } from "../server/jobs.mjs";

const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const DAY_MS = 24 * 3600 * 1000;
const T0 = 1_786_000_000_000;

function makeWorld() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const clock = { t: T0 };
  const escrow = new BountyEscrow(store, { now: () => clock.t, allowLegacyStringLanes: true });
  return { store, db, escrow, clock };
}

const expectConserved = (escrow, room) => {
  const c = escrow.verifyConservation(room);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

// Post -> fund -> claim -> submit -> accept at the world's current
// clock (10 credits, 3-day challenge window, deadline 30 days out).
function runToAccepted(world, room) {
  const { escrow, clock } = world;
  const bounty = escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount: 10,
      deadline: new Date(clock.t + 30 * DAY_MS).toISOString() }).bounty;
  escrow.fundBounty(room, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(room, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(room, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(room, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(clock.t).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(room, bounty.bountyId);
}

function runToClaimed(world, room, deadlineMs) {
  const { escrow } = world;
  const bounty = escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount: 10,
      deadline: new Date(deadlineMs).toISOString() }).bounty;
  escrow.fundBounty(room, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(room, bounty.bountyId, { claimant: GROK });
  return escrow.getBounty(room, bounty.bountyId);
}

test("S2: a lot becoming due mid-scan is NOT approved same-tick, and the summary counts agree", () => {
  const world = makeWorld();
  const { escrow, store, clock } = world;
  const roomA = "room-a", roomB = "room-b";
  escrow.ensureGenesis(roomA);
  escrow.ensureGenesis(roomB);
  // A and B1 are accepted 10s before B2, so at the scan instant their
  // challenge windows have passed while B2's ends 5s AFTER the scan.
  clock.t = T0 - 10_000;
  const a = runToAccepted(world, roomA);
  const b1 = runToAccepted(world, roomB);
  clock.t = T0;
  const b2 = runToAccepted(world, roomB);
  const scanNow = T0 + 3 * DAY_MS - 5_000;
  assert.equal(a.challengeEndsMs, scanNow - 5_000);
  assert.equal(b2.challengeEndsMs, scanNow + 5_000);

  // The original specimen's trigger: the escrow's live clock advances
  // +10s mid-scan (after the due query, before a room's close runs).
  const original = escrow.closeEpoch.bind(escrow);
  let advanced = false;
  escrow.closeEpoch = (roomId, opts) => {
    if (!advanced) { clock.t = scanNow + 10_000; advanced = true; }
    return original(roomId, opts);
  };
  const summary = progressEscrowEpochs(store, { now: scanNow, escrow });
  escrow.closeEpoch = original;

  // Unified tick: the close judged every bounty by scanNow, so B2 was
  // not pulled in, and what the tick did is exactly what it counted.
  assert.equal(summary.due, 2);
  assert.equal(summary.approved, 2, "approved must not exceed the scan's due count");
  assert.equal(summary.failed, 0);
  assert.equal(summary.overdue, 0);
  assert.equal(escrow.getBounty(roomA, a.bountyId).state, "approved");
  assert.equal(escrow.getBounty(roomB, b1.bountyId).state, "approved");
  assert.equal(escrow.getBounty(roomB, b2.bountyId).state, "accepted",
    "the mid-scan-due lot waits for the next tick, by the scan's clock");
  expectConserved(escrow, roomA);
  expectConserved(escrow, roomB);

  // The next tick, at/after B2's window, approves it — nothing was lost.
  clock.t = scanNow + 10_000;
  const next = progressEscrowEpochs(store, { now: clock.t, escrow });
  assert.equal(next.due, 3, "two approved sweeps plus B2's approval");
  assert.equal(next.approved, 1);
  assert.equal(next.paid, 2);
  assert.equal(escrow.getBounty(roomB, b2.bountyId).state, "approved");
  expectConserved(escrow, roomA);
  expectConserved(escrow, roomB);
});

test("S5 forward: scan clock ahead of the escrow clock settles in the same tick (no due-but-unactionable)", () => {
  const world = makeWorld();
  const { escrow, store, clock } = world;
  const room = "room-s5";
  escrow.ensureGenesis(room);
  const bounty = runToClaimed(world, room, T0 + 2 * DAY_MS);
  // Escrow clock stays at T0; the scan runs at T0+4d. Before the cure
  // this returned { due: 1, refunded: 0, overdue: 1 } on every tick.
  const summary = progressEscrowEpochs(store, { now: T0 + 4 * DAY_MS, escrow });
  assert.equal(summary.due, 1);
  assert.equal(summary.refunded, 1, "the tick's one `now` governs the close, not the escrow's live clock");
  assert.equal(summary.overdue, 0);
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "refunded");
  assert.equal(clock.t, T0, "the escrow clock was never consulted for the decision");
  expectConserved(escrow, room);
});

test("S5 reverse: escrow clock ahead of the scan clock cannot pull a lot in early", () => {
  const world = makeWorld();
  const { escrow, store, clock } = world;
  const room = "room-s5r";
  escrow.ensureGenesis(room);
  const bounty = runToClaimed(world, room, T0 + 2 * DAY_MS);
  clock.t = T0 + 4 * DAY_MS; // the escrow's live clock is past the deadline
  const journalRows = () =>
    store.db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=?").get(room).n;
  const before = journalRows();
  const summary = progressEscrowEpochs(store, { now: T0 - 1000, escrow });
  assert.equal(summary.due, 0);
  assert.equal(summary.rooms, 0, "the escrow is never invoked before the scan's clock says due");
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "claimed");
  assert.equal(journalRows(), before, "no settlement was split off by the divergent clock");
  expectConserved(escrow, room);
});

test("closeEpoch pins an explicit `now` for the whole close, and restores the live clock after", () => {
  const world = makeWorld();
  const { escrow, clock } = world;
  const room = "room-pin";
  escrow.ensureGenesis(room);
  const bounty = runToClaimed(world, room, T0 + 2 * DAY_MS);
  clock.t = T0 + 4 * DAY_MS; // live clock past the deadline
  const early = escrow.closeEpoch(room, { now: T0 + DAY_MS });
  assert.deepEqual(early.summary.refunded, [], "the pinned instant, not the live clock, judges the row");
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "claimed");
  assert.equal(escrow.nowMs(), T0 + 4 * DAY_MS, "the pin is lifted when the close returns");
  const due = escrow.closeEpoch(room, { now: T0 + 4 * DAY_MS });
  assert.equal(due.summary.refunded.length, 1);
  assert.equal(escrow.getBounty(room, bounty.bountyId).state, "refunded");
  assert.throws(() => escrow.closeEpoch(room, { now: NaN }), /finite/);
  expectConserved(escrow, room);
});

test("clock-source assertion: silent when the three sources are one source", () => {
  const T = T0;
  assert.ok(ESCROW_CLOCK_DIVERGENCE_TOLERANCE_MS > 0);
  // Identical source on all three legs (functions and values both work).
  assert.equal(assertUnifiedEscrowClocks({
    scanNow: () => T, store: { now: () => T }, escrow: { nowMs: () => T } }), 0);
  // The same wall clock sampled back to back: a few ms of spread is
  // one source, not divergence.
  assert.ok(assertUnifiedEscrowClocks({
    scanNow: T, store: { now: () => T + 3 }, escrow: { nowMs: () => T + 5 } }) <= 5);
  // Fewer than two observable sources: nothing that can disagree.
  assert.equal(assertUnifiedEscrowClocks({ scanNow: T }), 0);
  assert.equal(assertUnifiedEscrowClocks({}), 0);
  assert.equal(assertUnifiedEscrowClocks({ scanNow: T, store: {} }), 0);
});

test("clock-source assertion: fires when any of the three sources is wired elsewhere", () => {
  const T = T0;
  // Scan (job) frozen far from the escrow clock.
  assert.throws(() => assertUnifiedEscrowClocks({
    scanNow: T, escrow: { nowMs: () => T + 4 * DAY_MS } }), /escrow clock sources diverge/);
  // Store clock skewed against an agreeing scan + escrow pair.
  assert.throws(() => assertUnifiedEscrowClocks({
    scanNow: T, store: { now: () => T - 60_000 }, escrow: { nowMs: () => T } }),
    /store=\d+/);
  // The production shape, with a real escrow: a tick sample four days
  // from the store-wired escrow's clock names all sampled sources.
  const world = makeWorld();
  world.store.bountyEscrow = world.escrow;
  assert.throws(() => assertUnifiedEscrowClocks({
    scanNow: world.clock.t + 4 * DAY_MS, store: world.store }),
    /scan=\d+.*escrow=\d+|escrow=\d+.*scan=\d+/);
  assert.equal(assertUnifiedEscrowClocks({
    scanNow: world.clock.t, store: world.store }), 0);
});

test("the escrow-epochs job door asserts before it settles", async () => {
  const world = makeWorld();
  const { escrow, store, clock } = world;
  const room = "room-job";
  escrow.ensureGenesis(room);
  runToClaimed(world, room, T0 + 2 * DAY_MS);
  store.bountyEscrow = escrow; // the production store wiring (store.mjs)
  const job = jobByName("escrow-epochs");
  // Divergent job clock: the tick is refused, nothing settles.
  await assert.rejects(() => job.run(store, { now: () => clock.t + 4 * DAY_MS }),
    /escrow clock sources diverge/);
  // Unified job clock at the same instant the escrow sees: the tick
  // runs (and, the deadline not yet reached, settles nothing).
  const idle = await job.run(store, { now: () => clock.t });
  assert.equal(idle.due, 0);
  clock.t = T0 + 4 * DAY_MS;
  const ticked = await job.run(store, { now: () => clock.t });
  assert.equal(ticked.refunded, 1);
  expectConserved(escrow, room);
});
