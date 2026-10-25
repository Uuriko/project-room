// Acceptance coverage for #3550: the #2737 account-deletion purge deleted
// the deleted account's bounty_journal rows, orphaning the counterparty
// legs of the same movements and breaking the journal's hash chain /
// conservation audit. The journal is now retained under legal hold
// (tombstoned in place): legs stay byte-identical, attributed only to the
// deactivated account tombstone.
//
// Scenario (the issue's required test): two accounts fund -> settle a
// bounty between them, one account is deleted through the real
// plan + execute path, and the journal chain still validates end-to-end
// (verifyConservation: global sum == genesis sum, per-bounty coverage,
// per-account hash chains). On the pre-fix code both tests fail at the
// post-deletion conservation assertion.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";
import {
  planAccountDeletion,
  executeAccountDeletion,
} from "../server/account-deletion.mjs";

const ROOM = "commons";
const OWNER = "room-owner";   // room owner member; never deleted, holds no account in these tests
const POSTER = "u-poster";    // account id == member id (the attribution shape the #2737 purge keyed on)
const WORKER = "u-worker";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };

// Room owned by a third member; POSTER and WORKER are plain human members,
// each bound to a login account whose id equals its member id. Both start
// with the 100-credit genesis issuance.
function setup(t) {
  nowMs = 1_786_000_000_000;
  const store = new RoomStore(":memory:", { now: () => nowMs });
  store.initialize(initialRoom(ROOM, OWNER));
  t.after(() => store.close());
  const key = store.issueAccessKey(ROOM, OWNER);
  for (const memberId of [POSTER, WORKER]) {
    store.command(key, ROOM, {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "human", permissions: [...PERMISSIONS] },
    });
    store.createAccount(memberId);
    store.bindHumanAccount(ROOM, memberId, memberId);
  }
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis(ROOM);
  return { store, escrow };
}

// Post (POSTER) -> fund -> claim (WORKER) -> submit -> accept -> challenge
// window passes -> finalize -> epoch sweep pays out. Bounty ends "paid":
// WORKER holds 100 + 9.9 award + returned 1-credit bond; the pool holds 0.1.
function settleBounty(escrow) {
  const { bounty } = escrow.postBounty(ROOM, {
    poster: POSTER, title: "Settle me", criteria: "C", amount: 10,
    deadline: new Date(nowMs + 30 * 24 * 3600 * 1000).toISOString(),
  });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(ROOM, bounty.bountyId, {
    claimant: WORKER,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" },
  });
  escrow.acceptWork(ROOM, bounty.bountyId, {
    acceptor: POSTER,
    verifierAttestation: {
      at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }],
    },
  });
  tick(4 * 24 * 3600 * 1000); // past the 3-day challenge window for a 10-credit bounty
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: POSTER });
  escrow.closeEpoch(ROOM, { caller: POSTER });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

const legsOf = (store, lane) => store.db.prepare(
  "SELECT entry_id, kind, amount, lot_state, hash FROM bounty_journal WHERE room_id=? AND account_id=? ORDER BY seq",
).all(ROOM, lane);

const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

function assertDeletionTombstonesJournal(t, deleteId, counterpartyId) {
  const { store, escrow } = setup(t);
  const bounty = settleBounty(escrow);
  assert.equal(bounty.state, "paid");
  expectConserved(escrow);
  assert.equal(escrow.balances(ROOM, WORKER).payable, 109.9, "worker was paid 99% of 10 credits, bond returned");

  const legsBefore = legsOf(store, deleteId);
  assert.ok(legsBefore.length >= 4, `settled bounty leaves the deleting account with journal legs (${legsBefore.length})`);
  const counterpartyLegsBefore = legsOf(store, counterpartyId);
  const counterpartyBalanceBefore = escrow.balances(ROOM, counterpartyId);

  // The plan must disclose the journal as retained, counted, never purged.
  const { plan, summary } = planAccountDeletion(store, deleteId);
  const step = plan.steps.find(s => s.category === "bounty_journal");
  assert.ok(step, "plan includes a bounty_journal step");
  assert.equal(step.action, "retain", "bounty_journal is retained, not purged (#3550)");
  assert.equal(step.itemCount, legsBefore.length, "plan counts the account's journal legs");
  assert.match(summary.text, /Retention categories retained:.*bounty_journal/);

  const result = executeAccountDeletion(store, plan);
  assert.ok(result.retained.some(r => r.category === "bounty_journal"), "result reports bounty_journal retained");
  assert.ok(!result.purged.some(r => r.category === "bounty_journal"), "result does not report bounty_journal purged");

  // The account itself is really gone: deactivated tombstone, binding cut.
  assert.equal(store.account(deleteId).active, false, "account deactivated");
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get(deleteId).n, 0,
    "member bindings purged");

  // The ledger is untouched: the deleted account's legs are byte-identical,
  // the counterparty's legs and balance are unchanged, and the journal
  // chain still validates end-to-end.
  assert.deepEqual(legsOf(store, deleteId), legsBefore, "deleted account's journal legs retained in place");
  assert.deepEqual(legsOf(store, counterpartyId), counterpartyLegsBefore, "counterparty legs untouched");
  assert.deepEqual(escrow.balances(ROOM, counterpartyId), counterpartyBalanceBefore, "counterparty balance unchanged");
  expectConserved(escrow);
}

test("fund -> settle -> delete the POSTER: journal chain still validates", t => {
  assertDeletionTombstonesJournal(t, POSTER, WORKER);
});

test("fund -> settle -> delete the WORKER: journal chain still validates", t => {
  assertDeletionTombstonesJournal(t, WORKER, POSTER);
});
