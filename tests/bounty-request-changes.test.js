// UT2 conversion — REQUEST-CHANGES (charter request-changes.md, Option A).
// A poster/verifier who judges a submitted bounty delivery fixable but not
// acceptable returns it to the SAME worker on the SAME claim for
// re-delivery: escrow and claim bond stay locked, no bond forfeit, no flake
// strike (R1); rework is bounded at 2 rounds, after which the refusal names
// the remaining outcomes accept / reject / dispute (R2); every delivery
// generation stays readable (R4); the reviewer summary is mandatory and a
// refusal names the `summary` field (R5). The accept-after-rework settles
// exactly as a first-round accept (conservation to the cent).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, REQUEST_CHANGES_PATH_PHRASE } from "../server/bounty-escrow.mjs";

const ROOM = "room-request-changes";
const POSTER = "id:agent/jill";
const WORKER = "id:agent/grokbot";
const THIRD = "id:agent/instinct";

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
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

const RUBRIC = [
  { criterionId: "c1", description: "States the assigned fact correctly" },
  { criterionId: "c2", description: "Explains why the fact matters in one sentence" },
];

function runToSubmitted(escrow, amount = 4) {
  const bounty = escrow.postBounty(ROOM,
    { poster: POSTER, title: "T", criteria: "C", amount, deadline: isoFuture(3_600_000), rubric: RUBRIC }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: "https://example.invalid/work-v1", summary: "first delivery" } });
  return bounty;
}

const snapshot = (escrow, db) => JSON.stringify({
  poster: escrow.balances(ROOM, POSTER), worker: escrow.balances(ROOM, WORKER),
  pool: escrow.balances(ROOM, "pool"),
  journalRows: db.prepare("SELECT count(*) AS n FROM bounty_journal").get().n,
});
const strikes = escrow => escrow.balances(ROOM, WORKER).flake.strikes;
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

test("request-changes returns a submitted bounty to the worker; re-delivery and accept settle as a first-round accept", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  const before = snapshot(escrow, db);
  assert.equal(strikes(escrow), 0);

  const { bounty: returned, receipt } = escrow.requestChangesWork(ROOM, bounty.bountyId,
    { requester: POSTER, summary: "c2 is missing — add the why-it-matters sentence" });
  assert.equal(returned.state, "claimed");
  assert.equal(returned.group, "claimed");
  assert.equal(returned.reworkRounds, 1);
  assert.equal(returned.maxReworkRounds, 2);
  assert.deepEqual(returned.changesRequested.summary, "c2 is missing — add the why-it-matters sentence");
  assert.equal(returned.changesRequested.by, POSTER);
  assert.equal(returned.changesRequested.round, 1);
  assert.equal(receipt.kind, "request-changes");
  // R1: no money moved, no strike — balances and journal byte-identical.
  assert.equal(snapshot(escrow, db), before);
  assert.equal(strikes(escrow), 0);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);

  const resubmitted = escrow.submitWork(ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: "https://example.invalid/work-v2", summary: "second delivery, c2 added" } }).bounty;
  assert.equal(resubmitted.state, "submitted");
  assert.equal(resubmitted.changesRequested, null);
  // R4: both delivery generations stay readable, in order.
  assert.equal(resubmitted.deliveries.length, 2);
  assert.equal(resubmitted.deliveries[0].generation, 1);
  assert.equal(resubmitted.deliveries[0].evidence.evidenceUrl, "https://example.invalid/work-v1");
  assert.equal(resubmitted.deliveries[1].generation, 2);
  assert.equal(resubmitted.deliveries[1].evidence.evidenceUrl, "https://example.invalid/work-v2");
  assert.equal(snapshot(escrow, db), before, "re-delivery itself moves no money either");
  assert.equal(strikes(escrow), 0);

  const accepted = escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: POSTER,
    verifierAttestation: { at: new Date(nowMs).toISOString(),
      citations: [{ criterionId: "c1", verdict: "pass" }, { criterionId: "c2", verdict: "pass" }] } }).bounty;
  assert.equal(accepted.state, "accepted");
  assert.ok(accepted.challengeEndsMs > nowMs, "challenge window runs from the accepting act");
  assert.equal(escrow.balances(ROOM, WORKER).attributed, 4);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("request-changes without a summary refuses, naming the summary field, and moves nothing", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  const before = snapshot(escrow, db);
  for (const summary of [undefined, "", "   "]) {
    const error = expectCode(() => escrow.requestChangesWork(ROOM, bounty.bountyId, { requester: POSTER, summary }), "invalid_input");
    assert.match(error.message, /summary/, "the refusal names the summary field");
  }
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  assert.equal(snapshot(escrow, db), before);
});

test("request-changes is approver-only, never the claimant, and only from submitted", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  expectCode(() => escrow.requestChangesWork(ROOM, bounty.bountyId, { requester: WORKER, summary: "self send-back" }), "not_authorized");
  expectCode(() => escrow.requestChangesWork(ROOM, bounty.bountyId, { requester: THIRD, summary: "not my review" }), "not_authorized");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  // From claimed (never submitted) the state guard refuses.
  const fresh = escrow.postBounty(ROOM, { poster: POSTER, title: "T2", criteria: "C", amount: 4,
    deadline: isoFuture(3_600_000), rubric: RUBRIC }).bounty;
  escrow.fundBounty(ROOM, fresh.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, fresh.bountyId, { claimant: WORKER });
  expectCode(() => escrow.requestChangesWork(ROOM, fresh.bountyId, { requester: POSTER, summary: "too early" }), "invalid_state");
});

test("rework bound: the third request-changes refuses, naming accept / reject / dispute and the shared request-changes phrase", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  // The phrase candidate 3's accept guard (PR #5072) names in its 422 —
  // one string, pinned here from this side verbatim.
  assert.equal(REQUEST_CHANGES_PATH_PHRASE,
    "for work that needs changes, use the request-changes path (return the delivery to the worker for changes) instead of accepting it, or reject the delivery");
  for (let round = 1; round <= 2; round++) {
    escrow.requestChangesWork(ROOM, bounty.bountyId, { requester: POSTER, summary: `round ${round} fixes` });
    escrow.submitWork(ROOM, bounty.bountyId, { claimant: WORKER,
      evidence: { evidenceUrl: `https://example.invalid/work-v${round + 1}`, summary: `delivery ${round + 1}` } });
  }
  const error = expectCode(() => escrow.requestChangesWork(ROOM, bounty.bountyId,
    { requester: POSTER, summary: "round 3 fixes" }), "rework_limit_reached");
  assert.match(error.message, /accept/);
  assert.match(error.message, /reject/);
  assert.match(error.message, /dispute/);
  assert.ok(error.message.includes(REQUEST_CHANGES_PATH_PHRASE), "bound refusal carries the shared request-changes phrase");
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted");
  assert.equal(after.reworkRounds, 2);
  assert.equal(after.deliveries.length, 3);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
