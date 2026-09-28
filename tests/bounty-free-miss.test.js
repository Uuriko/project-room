// Unit + HTTP tests for free-miss settlement (docs/FREE-MISS-SETTLEMENT.md):
// failed or unverified work settles at zero; agents earn only on verified
// completion. Settlement points live in server/bounty-escrow.mjs
// (BountyEscrow): rejectWork (new), _settleUnverified (new keeper path),
// and settlement records stamped on the existing terminal paths
// (dispute settle, timeout refund, epoch sweep).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
const INSTINCT = "id:agent/instinct"; // verifier / challenger lane
const CODEX = "id:agent/codex";    // challenger lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000; // >= 1 credit bounties

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

const bal = (escrow, lane) => escrow.balances(ROOM, lane);
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const journalRows = db => db.prepare("SELECT COUNT(*) AS c FROM bounty_journal WHERE room_id=?").get(ROOM).c;
const settledEvents = (db, bountyId) => db.prepare(
  "SELECT COUNT(*) AS c FROM bounty_events WHERE room_id=? AND bounty_id=? AND type='bounty.settled'").get(ROOM, bountyId).c;
const flakeRows = (db, lane, bountyId) => db.prepare(
  "SELECT COUNT(*) AS c FROM bounty_flakes WHERE room_id=? AND lane=? AND bounty_id=?").get(ROOM, lane, bountyId).c;

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

// Post -> fund -> claim -> submit.
function runToSubmitted(escrow, { amount = 10, verifier = null } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// Post -> fund -> claim -> submit -> accept.
function runToAccepted(escrow, { amount = 10, verifier = null } = {}) {
  const bounty = runToSubmitted(escrow, { amount, verifier });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("verified-complete earns: accept -> approve -> sweep pays the worker and stamps the settlement", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10 });
  tick(CHALLENGE_WINDOW_MS + 1);
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(fin.action, "approved");
  escrow.closeEpoch(ROOM, {});
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.state, "paid");
  assert.equal(settled.resolution.settlement.kind, "verified-complete");
  assert.equal(settled.resolution.settlement.workerMillis, 9900);
  assert.equal(settled.resolution.settlement.refundMillis, 0);
  // Worker: 99 payable (100 - 1 bond) + bond back + 9.9 net of the 1% fee.
  assert.equal(bal(escrow, GROK).payable, 109.9);
  assert.equal(bal(escrow, "pool").payable, 0.1);
  assert.equal(settledEvents(db, bounty.bountyId), 1);
  expectConserved(escrow);
});

test("failed: rejectWork settles the worker at zero, refunds the poster, forfeits the bond", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { amount: 10 });
  const { settlement, alreadySettled, receipt } = escrow.rejectWork(ROOM, bounty.bountyId,
    { rejector: JILL, reason: "did not meet the criteria" });
  assert.equal(alreadySettled, false);
  assert.equal(settlement.kind, "failed");
  assert.equal(settlement.workerMillis, 0);
  assert.equal(settlement.refundMillis, 10000);
  assert.equal(receipt.kind, "reject");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.state, "refunded");
  assert.equal(settled.resolution.kind, "rejected");
  assert.equal(settled.resolution.rejectedBy, JILL);
  // Escrow to the poster in full, no fee; the worker earned nothing.
  assert.equal(bal(escrow, JILL).payable, 100);
  assert.equal(bal(escrow, JILL).locked, 0);
  assert.equal(bal(escrow, GROK).payable, 99); // 100 - 1 bond, forfeited to the pool
  assert.equal(bal(escrow, GROK).locked, 0);
  assert.equal(bal(escrow, "pool").payable, 1);
  // Anti-flake: a strike is recorded for work judged bad.
  assert.equal(flakeRows(db, GROK, bounty.bountyId), 1);
  assert.equal(settledEvents(db, bounty.bountyId), 1);
  expectConserved(escrow);
});

test("unverified: keeper settles never-verified work at zero, escrow to poster, bond returned", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { amount: 10 });
  tick(3_600_000 + 1); // past the deadline with no verdict
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(fin.action, "refunded");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.resolution.settlement.kind, "unverified");
  assert.equal(settled.resolution.settlement.workerMillis, 0);
  assert.equal(settled.resolution.settlement.refundMillis, 10000);
  assert.equal(bal(escrow, JILL).payable, 100);
  // The worker submitted on time: the bond comes home, no flake strike.
  assert.equal(bal(escrow, GROK).payable, 100);
  assert.equal(bal(escrow, GROK).locked, 0);
  assert.equal(flakeRows(db, GROK, bounty.bountyId), 0);
  assert.equal(settledEvents(db, bounty.bountyId), 1);
  expectConserved(escrow);
});

test("double-settle is a no-op: the second reject replays the stored verdict, no new journal rows", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, { amount: 10 });
  const first = escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason: "no good" });
  const rowsAfterFirst = journalRows(db);
  const jillAfterFirst = bal(escrow, JILL), grokAfterFirst = bal(escrow, GROK), poolAfterFirst = bal(escrow, "pool");
  const second = escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason: "no good" });
  assert.equal(second.alreadySettled, true);
  assert.deepEqual(second.settlement, first.settlement);
  assert.equal(journalRows(db), rowsAfterFirst, "no new journal movement on replay");
  assert.deepEqual(bal(escrow, JILL), jillAfterFirst);
  assert.deepEqual(bal(escrow, GROK), grokAfterFirst);
  assert.deepEqual(bal(escrow, "pool"), poolAfterFirst);
  assert.equal(settledEvents(db, bounty.bountyId), 1, "one settlement event, not two");
  expectConserved(escrow);
});

test("double-complete cannot double-pay: a second epoch close pays nothing new", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10 });
  tick(CHALLENGE_WINDOW_MS + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  const paidOnce = bal(escrow, GROK).payable;
  assert.equal(paidOnce, 109.9);
  escrow.closeEpoch(ROOM, {});
  assert.equal(bal(escrow, GROK).payable, paidOnce, "second sweep paid nothing new");
  expectConserved(escrow);
});

test("dispute interplay: upheld settles failed, released settles verified-complete, split is the only partial", () => {
  // UPHELD = failed: full refund to the poster, worker 0.
  {
    const { escrow, db } = makeEscrow();
    const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
    escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "plagiarized" });
    const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
      { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
    assert.equal(settled.resolution.settlement.kind, "failed");
    assert.equal(settled.resolution.settlement.workerMillis, 0);
    assert.equal(settled.resolution.settlement.refundMillis, 10000);
    assert.equal(bal(escrow, JILL).payable, 100);
    assert.equal(settledEvents(db, bounty.bountyId), 1);
    expectConserved(escrow);
  }
  // RELEASED = verified-complete: the award vests with the worker.
  {
    const { escrow, db } = makeEscrow();
    const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
    escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "looks wrong" });
    const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
      { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
    assert.equal(settled.resolution.settlement.kind, "verified-complete");
    assert.equal(settled.resolution.settlement.workerMillis, 10000);
    escrow.closeEpoch(ROOM, {});
    assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
    assert.equal(settledEvents(db, bounty.bountyId), 1);
    expectConserved(escrow);
  }
  // SPLIT = partial: the one explicit partial-credit exception.
  {
    const { escrow, db } = makeEscrow();
    const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
    escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "half done" });
    const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
      { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
    assert.equal(settled.resolution.settlement.kind, "partial");
    assert.equal(settled.resolution.settlement.workerMillis, 5000);
    assert.equal(settled.resolution.settlement.refundMillis, 5000);
    escrow.closeEpoch(ROOM, {});
    // Worker: half vests, 1% fee at sweep; poster: half refunded.
    assert.equal(bal(escrow, GROK).payable, 99 + 1 + 4.95);
    assert.equal(bal(escrow, JILL).payable, 90 + 5);
    assert.equal(settledEvents(db, bounty.bountyId), 1);
    expectConserved(escrow);
  }
});

test("timeout refund settles unverified: work never completed, escrow to poster, worker 0", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow, { amount: 10 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(3_600_000 + 1);
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(fin.action, "refunded");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.resolution.settlement.kind, "unverified");
  assert.equal(settled.resolution.settlement.workerMillis, 0);
  assert.equal(settled.resolution.settlement.refundMillis, 10000);
  assert.equal(bal(escrow, JILL).payable, 100);
  assert.equal(settledEvents(db, bounty.bountyId), 1);
  expectConserved(escrow);
});

test("rejectWork authorization: poster or verifier only, never the claimant", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { amount: 10, verifier: INSTINCT });
  expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId, { rejector: GROK, reason: "self" }), "not_authorized");
  expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId, { rejector: CODEX, reason: "stranger" }), "not_authorized");
  // The designated verifier may reject too.
  const { settlement } = escrow.rejectWork(ROOM, bounty.bountyId, { rejector: INSTINCT, reason: "bad" });
  assert.equal(settlement.kind, "failed");
  expectConserved(escrow);
});

test("rejectWork requires a submitted bounty with a written reason", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, {});
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason: "early" }), "invalid_state");
  const submitted = runToSubmitted(escrow, {});
  expectCode(() => escrow.rejectWork(ROOM, submitted.bountyId, { rejector: JILL, reason: "" }), "invalid_input");
  expectCode(() => escrow.rejectWork(ROOM, "ROOM-999", { rejector: JILL, reason: "x" }), "unknown_bounty");
});

// --- HTTP: the /reject route ------------------------------------------------
// POST /api/rooms/{roomId}/bounties/{bountyId}/reject {reason} settles failed
// over the wire and replays idempotently.
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const HROOM = "commons";
async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"]) {
      escrow._append({ roomId: HROOM, accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable",
        memo: "test seeding: 100 credits", actor: { kind: "rule", id: "test" } });
    }
  });
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, keys: fixture.keys };
}
const hpost = (origin, path, body, secret, extraHeaders = {}) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...extraHeaders },
  body: JSON.stringify(body),
});
const bountyBody = () => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change with a before/after example.",
  amount: 100,
  deadline: new Date(Date.now() + 86400000).toISOString(),
});

test("HTTP: POST /reject settles failed and replays the stored verdict on a second call", async t => {
  const { origin, keys } = await startServer(t);
  const created = await (await hpost(origin, `/api/rooms/${HROOM}/bounties`, bountyBody(), keys.owner)).json();
  const bountyId = created.bounty.bountyId;
  await hpost(origin, `/api/rooms/${HROOM}/bounties/${bountyId}/fund`, {}, keys.owner);
  await hpost(origin, `/api/rooms/${HROOM}/bounties/${bountyId}/claim`, {}, keys.producer);
  await hpost(origin, `/api/rooms/${HROOM}/bounties/${bountyId}/submit`, {
    evidenceUrl: "https://room.example/receipts/1", summary: "Migration guide drafted.",
  }, keys.producer);

  const rejectRes = await hpost(origin, `/api/rooms/${HROOM}/bounties/${bountyId}/reject`,
    { reason: "missed the breaking-changes section" }, keys.owner,
    { "idempotency-key": "free-miss-http-1" });
  assert.equal(rejectRes.status, 200);
  const rejected = await rejectRes.json();
  assert.equal(rejected.bounty.state, "refunded");
  assert.equal(rejected.alreadySettled, false);
  assert.equal(rejected.settlement.kind, "failed");
  assert.equal(rejected.settlement.workerMillis, 0);
  assert.equal(rejected.settlement.refundMillis, 100 * 1000);

  // The producer (claimant) cannot reject their own work.
  const selfReject = await hpost(origin, `/api/rooms/${HROOM}/bounties/${bountyId}/reject`,
    { reason: "self" }, keys.producer);
  assert.equal(selfReject.status, 403);

  // Replaying the same idempotency key returns the stored response body.
  const replayRes = await hpost(origin, `/api/rooms/${HROOM}/bounties/${bountyId}/reject`,
    { reason: "missed the breaking-changes section" }, keys.owner,
    { "idempotency-key": "free-miss-http-1" });
  assert.equal(replayRes.status, 200);
  assert.deepEqual(await replayRes.json(), rejected);
});

test("rejection keeps the full 500-character reason without overflowing settlement validation", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  const before = journalRows(db);
  expectCode(() => escrow.rejectWork(ROOM, bounty.bountyId,
    { rejector: JILL, reason: "r".repeat(501) }), "invalid_input");
  assert.equal(journalRows(db), before);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  const reason = "r".repeat(500);
  const { settlement } = escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason });
  assert.equal(settlement.reason, reason);
  assert.equal(settlement.kind, "failed");
  assert.equal(settlement.settledBy.id, JILL);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).resolution.reason, reason);
  assert.equal(settledEvents(db, bounty.bountyId), 1);
  expectConserved(escrow);
  const rowsAfter = journalRows(db);
  assert.equal(escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason }).alreadySettled, true);
  assert.equal(journalRows(db), rowsAfter);
});
