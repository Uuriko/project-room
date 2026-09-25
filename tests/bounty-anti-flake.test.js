// Agent work exchange slice 8: the graduated anti-flake ladder.
//
// Flake strikes decay (30d); the rung escalates forfeit -> 2x bond ->
// 7-day cooldown. Every ladder step is journaled (flake.recorded,
// flake.decayed, flake.cooldown-ended, bond-forfeit/bond-return), the
// cooldown is visible on the identity card, and nothing in the ladder bans
// a lane or touches payouts — it moves ledger units and gates claims.
// Credits are valueless ledger units: no cash-out, no on-chain touch.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BountyEscrow, CLAIM_BOND_MILLIS, FLAKE_DECAY_MS, FLAKE_COOLDOWN_MS,
} from "../server/bounty-escrow.mjs";

const ROOM = "room-flake";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

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

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const fund = (escrow, bountyId) => escrow.fundBounty(ROOM, bountyId, { funder: JILL });
const claim = (escrow, bountyId, claimant = GROK) =>
  escrow.claimBounty(ROOM, bountyId, { claimant });
// Claim, then let the deadline pass with no submission: a timeout flake.
const flakeTimeout = (escrow, { claimant = GROK, amount = 10 } = {}) => {
  const bounty = post(escrow, { amount });
  fund(escrow, bounty.bountyId);
  claim(escrow, bounty.bountyId, claimant);
  tick(3_600_000 + 1);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  assert.equal(action, "refunded");
  return bounty;
};
const flakeCard = (escrow, lane = GROK) => escrow.balances(ROOM, lane).flake;
const flakeEvents = (escrow, type) =>
  escrow.store.db.prepare("SELECT data FROM bounty_events WHERE room_id=? AND type=?").all(ROOM, type)
    .map(r => JSON.parse(r.data));
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

test("rung 1: timeout flakes forfeit the bond and journal the strike", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow);
  // Forfeit: the 1-credit bond moves to the pool, not back to the claimant.
  assert.equal(escrow.balances(ROOM, GROK).payable, 99);
  assert.equal(escrow.balances(ROOM, "pool").payable, 1);
  const forfeits = escrow.store.db.prepare(
    "SELECT * FROM bounty_journal WHERE room_id=? AND kind='bond-forfeit' AND amount > 0").all(ROOM);
  assert.equal(forfeits.length, 1);
  assert.equal(forfeits[0].amount, CLAIM_BOND_MILLIS);
  // The strike is journaled with its rung.
  const recorded = flakeEvents(escrow, "flake.recorded");
  assert.equal(recorded.length, 1);
  assert.deepEqual({ strikes: recorded[0].strikes, rung: recorded[0].rung, reason: recorded[0].reason },
    { strikes: 1, rung: 1, reason: "timeout-no-submit" });
  // The identity card shows the ladder position.
  assert.deepEqual(flakeCard(escrow),
    { strikes: 1, rung: 1, bondMultiplier: 1, cooldownUntil: null });
  expectConserved(escrow);
});

test("rung 2: the next claim requires a double bond, settled in full", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow);
  flakeTimeout(escrow);
  assert.deepEqual(flakeCard(escrow), { strikes: 2, rung: 2, bondMultiplier: 2, cooldownUntil: null });
  // The next claim locks 2 credits, not 1.
  const bounty = post(escrow);
  fund(escrow, bounty.bountyId);
  claim(escrow, bounty.bountyId);
  assert.equal(escrow.balances(ROOM, GROK).locked, 2);
  assert.equal(escrow.balances(ROOM, GROK).payable, 96); // 100 - 1 - 1 forfeits - 2 locked
  // Submit so the timeout path does not strike again; the doubled bond
  // returns in full at sweep (the actual locked amount settles, not the
  // constant). Accept -> challenge window -> approve -> epoch sweep.
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/2", summary: "on time" } });
  const att = { at: new Date(nowMs).toISOString(), note: "lgtm",
    citations: [{ criterionId: "c1", verdict: "pass" }] };
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: att });
  tick(3 * 24 * 3600 * 1000 + 1);
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  assert.equal(fin.action, "approved");
  escrow.closeEpoch(ROOM, {});
  assert.equal(escrow.balances(ROOM, GROK).locked, 0);
  assert.equal(escrow.balances(ROOM, GROK).payable, 96 + 9.9 + 2,
    "the doubled bond returns whole at sweep alongside the 99% payout");
  expectConserved(escrow);
});

test("rung 2 flake forfeits the doubled bond", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow); // -1 -> payable 99
  flakeTimeout(escrow); // -1 -> payable 98
  flakeTimeout(escrow); // rung 2 at claim: locks 2, forfeits 2 -> payable 96
  assert.equal(escrow.balances(ROOM, GROK).payable, 96);
  assert.equal(escrow.balances(ROOM, "pool").payable, 4); // 1 + 1 + 2 forfeited
  expectConserved(escrow);
});

test("rung 3: cooldown gates new claims and is visible on the identity card", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow);
  flakeTimeout(escrow);
  flakeTimeout(escrow);
  const card = flakeCard(escrow);
  assert.equal(card.strikes, 3);
  assert.equal(card.rung, 3);
  assert.ok(card.cooldownUntil, "cooldown is visible on the identity card");
  assert.equal(card.cooldownUntil, new Date(nowMs + FLAKE_COOLDOWN_MS).toISOString());
  // The cooldown-start journaled with the rung-3 strike.
  const recorded = flakeEvents(escrow, "flake.recorded");
  assert.equal(recorded.length, 3);
  assert.equal(recorded[2].rung, 3);
  assert.equal(recorded[2].cooldownUntil, card.cooldownUntil);
  // New claims are rejected until the cooldown ends.
  const bounty = post(escrow);
  fund(escrow, bounty.bountyId);
  expectCode(() => claim(escrow, bounty.bountyId), "claim_cooldown");
  expectConserved(escrow);
});

test("cooldown expiry re-opens claims and journals the end; decay resets the rung and journals once", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow);
  flakeTimeout(escrow);
  flakeTimeout(escrow);
  // Cooldown passes: claims work again and the end is journaled.
  tick(FLAKE_COOLDOWN_MS + 1);
  const bounty = post(escrow);
  fund(escrow, bounty.bountyId);
  claim(escrow, bounty.bountyId); // no claim_cooldown after expiry
  const ended = flakeEvents(escrow, "flake.cooldown-ended");
  assert.equal(ended.length, 1, "cooldown-end journals exactly once");
  // Strikes are still inside the decay window: rung 3, double bond on this claim.
  assert.equal(escrow.balances(ROOM, GROK).locked, 2);
  // Decay passes: the ladder resets to clean and decay journals once.
  tick(FLAKE_DECAY_MS);
  const bounty2 = post(escrow);
  fund(escrow, bounty2.bountyId);
  const lockedBefore = escrow.balances(ROOM, GROK).locked;
  claim(escrow, bounty2.bountyId); // single bond again (b1's 2-credit bond is still locked)
  assert.equal(escrow.balances(ROOM, GROK).locked - lockedBefore, 1, "decayed strikes stop counting");
  assert.deepEqual(flakeCard(escrow), { strikes: 0, rung: 0, bondMultiplier: 1, cooldownUntil: null });
  const decayed = flakeEvents(escrow, "flake.decayed");
  assert.equal(decayed.length, 1, "decay journals exactly once");
  assert.equal(decayed[0].strikesDecayed, 3);
  expectConserved(escrow);
});

test("decay journal is idempotent: later claims do not re-journal", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow);
  tick(FLAKE_DECAY_MS + 1);
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId);
  assert.equal(flakeEvents(escrow, "flake.decayed").length, 1);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId);
  assert.equal(flakeEvents(escrow, "flake.decayed").length, 1, "no duplicate decay journal");
  expectConserved(escrow);
});

test("dispute-upheld records a flake strike: forfeit plus ladder journal", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 10, verifierId: "id:agent/instinct" });
  fund(escrow, bounty.bountyId);
  claim(escrow, bounty.bountyId);
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/9", summary: "bad work" } });
  const att = { at: new Date(nowMs).toISOString(), note: "lgtm",
    citations: [{ criterionId: "c1", verdict: "pass" }] };
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: att });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: "id:agent/codex", bond: 2.5, grounds: "bad" });
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: "id:agent/instinct", outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "cancel");
  // The bond forfeit is the rung-1 consequence, and the strike is journaled.
  assert.equal(escrow.balances(ROOM, "pool").payable, 1);
  const recorded = flakeEvents(escrow, "flake.recorded");
  assert.equal(recorded.length, 1);
  assert.deepEqual({ strikes: recorded[0].strikes, rung: recorded[0].rung, reason: recorded[0].reason,
      lane: recorded[0].lane },
    { strikes: 1, rung: 1, reason: "dispute-upheld", lane: GROK });
  assert.deepEqual(flakeCard(escrow), { strikes: 1, rung: 1, bondMultiplier: 1, cooldownUntil: null });
  expectConserved(escrow);
});

test("flakes are lane-scoped and room-scoped: other lanes are unaffected", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow, { claimant: GROK });
  // Another worker claims cleanly at the base bond.
  const bounty = post(escrow);
  fund(escrow, bounty.bountyId);
  claim(escrow, bounty.bountyId, "id:agent/codex");
  assert.equal(escrow.balances(ROOM, "id:agent/codex").locked, 1);
  assert.deepEqual(escrow.balances(ROOM, "id:agent/codex").flake,
    { strikes: 0, rung: 0, bondMultiplier: 1, cooldownUntil: null });
  expectConserved(escrow);
});

test("the ladder never bans and never touches payouts: strikes are not reputation", () => {
  const { escrow } = makeEscrow();
  flakeTimeout(escrow);
  flakeTimeout(escrow);
  flakeTimeout(escrow);
  // Reputation still derives only from paid completions: three flakes, zero
  // paid bounties, reputation untouched.
  const rep = escrow.balances(ROOM, GROK).reputation;
  assert.equal(rep.completedBounties, 0);
  assert.equal(rep.earnedCredits, 0);
  // And the ladder gates claims only — a clean lane can still be paid in
  // full for the same room.
  expectConserved(escrow);
});
