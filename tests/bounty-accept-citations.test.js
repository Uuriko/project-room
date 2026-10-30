// UT2 conversion candidate 3 (lane 02-04 F1): accept must honour its
// citations. Before this cure, accept with citations [{c1,pass},{c2,fail}]
// returned success, attributed the award and permanently recorded the fail
// citation next to the acceptance — the gate checked that citations exist,
// never what they say. The cure: a server-side guard — an accept carrying
// any fail citation is refused 422 `accept_has_fail_citations`, naming the
// request-changes path (the request-changes verb itself is chartered
// separately; this guard names the expectation, it does not build the verb).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-accept-citations";
const POSTER = "id:agent/jill";
const WORKER = "id:agent/grokbot";

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
  return escrow;
}

const RUBRIC = [
  { criterionId: "c1", description: "States the assigned fact correctly" },
  { criterionId: "c2", description: "Explains why the fact matters in one sentence" },
];

function runToSubmitted(escrow) {
  const bounty = escrow.postBounty(ROOM,
    { poster: POSTER, title: "T", criteria: "C", amount: 4, deadline: isoFuture(3_600_000), rubric: RUBRIC }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: "https://example.invalid/work", summary: "delivered" } });
  return bounty;
}

const acceptWith = (escrow, bountyId, citations) => () => escrow.acceptWork(ROOM, bountyId,
  { acceptor: POSTER, verifierAttestation: { at: new Date(nowMs).toISOString(), citations } });

test("accept with any fail citation is refused, naming the failed criteria and the request-changes path", () => {
  const escrow = makeEscrow();
  const bounty = runToSubmitted(escrow);
  let error = null;
  try {
    acceptWith(escrow, bounty.bountyId, [{ criterionId: "c1", verdict: "pass" }, { criterionId: "c2", verdict: "fail" }])();
  } catch (caught) { error = caught; }
  assert.ok(error, "accept with a fail citation must throw");
  assert.equal(error.code, "accept_has_fail_citations");
  assert.match(error.message, /c2/);
  assert.match(error.message, /request-changes/i);
  // Nothing moved: the bounty is still submitted, no attestation recorded,
  // the award is still locked with the poster, nothing attributed.
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted");
  assert.equal(after.attestation, null);
  assert.equal(escrow.balances(ROOM, WORKER).attributed, 0);
  assert.equal(escrow.balances(ROOM, POSTER).locked, 4);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("accept with a single fail citation is refused even when it is the only citation failure", () => {
  const escrow = makeEscrow();
  const bounty = runToSubmitted(escrow);
  assert.throws(
    acceptWith(escrow, bounty.bountyId, [{ criterionId: "c1", verdict: "fail" }, { criterionId: "c2", verdict: "fail" }]),
    error => error.code === "accept_has_fail_citations" && /c1/.test(error.message) && /c2/.test(error.message));
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
});

test("accept with all-pass citations still succeeds and records the attestation", () => {
  const escrow = makeEscrow();
  const bounty = runToSubmitted(escrow);
  const { bounty: accepted } = escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: POSTER, verifierAttestation: { at: new Date(nowMs).toISOString(),
      citations: [{ criterionId: "c1", verdict: "pass" }, { criterionId: "c2", verdict: "pass" }] } });
  assert.equal(accepted.state, "accepted");
  assert.deepEqual(accepted.attestation.citations.map(c => c.verdict), ["pass", "pass"]);
  assert.equal(escrow.balances(ROOM, WORKER).attributed, 4);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
