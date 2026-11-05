// UT2 conversion candidate 2 (lane 02-05 F-1/F-2): the dispute case file.
// Before this cure the poster's grounds appeared in ZERO executed reads for
// any party (GET .../dispute 405'd for everyone), the decider's reasonCodes
// were dropped from the resolution, and BOTH executed rulings printed
// bondForfeited:false while bonds moved in both outcomes (the poster's bond
// compensated the worker on a rejected ruling; the worker's claim bond was
// forfeited to the pool on an upheld ruling). The cure: a party-scoped
// dispute read model on the bounty (grounds, reasonCodes, bond movements)
// and ruling/settlement surfaces that state the full bond consequences.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { ensureSpendGrantsSchema, issueSpendGrant } from "../server/spend-grants.mjs";

const ROOM = "room-dispute-case";
const POSTER = "id:agent/jill";
const WORKER = "id:agent/grokbot";
const DECIDER = "id:agent/instinct";
const OUTSIDER = "id:agent/codex";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
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

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const expectConserved = escrow =>
  assert.equal(escrow.verifyConservation(ROOM).ok, true);

function runToAccepted(escrow) {
  const bounty = escrow.postBounty(ROOM,
    { poster: POSTER, title: "T", criteria: "C", amount: 4, deadline: isoFuture(3_600_000), verifierId: DECIDER }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: "https://example.invalid/work", summary: "28 words, no maintenance sentence" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: POSTER,
    verifierAttestation: { at: new Date(nowMs).toISOString(), citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

const GROUNDS = "only 28 words and no maintenance sentence: criterion c1 is not met";

test("case file: grounds, parties and bond are readable by poster, worker and decider while adjudicating", () => {
  const escrow = makeEscrow();
  const bounty = runToAccepted(escrow);
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: POSTER, bond: 1, grounds: GROUNDS });
  for (const viewer of [POSTER, WORKER, DECIDER]) {
    const caseFile = escrow.getDisputeCase(ROOM, bounty.bountyId, { viewer });
    assert.equal(caseFile.disputeId, dispute.disputeId);
    assert.equal(caseFile.grounds, GROUNDS, `grounds must be visible to ${viewer}`);
    assert.equal(caseFile.raisedBy, POSTER);
    assert.equal(caseFile.poster, POSTER);
    assert.equal(caseFile.worker, WORKER);
    assert.equal(caseFile.decider, DECIDER);
    assert.equal(caseFile.state, "adjudicating");
    assert.equal(caseFile.bond, 1);
    assert.equal(caseFile.outcome, null);
    assert.deepEqual(caseFile.bondConsequences.disputeBond,
      { amount: 1, disposition: "locked", from: POSTER, to: null });
  }
  // A room member who is not a party to the dispute cannot read the case.
  expectCode(() => escrow.getDisputeCase(ROOM, bounty.bountyId, { viewer: OUTSIDER }), "not_authorized");
  expectConserved(escrow);
});

test("case file: a bounty with no dispute has no case file", () => {
  const escrow = makeEscrow();
  const bounty = runToAccepted(escrow);
  assert.equal(escrow.getDisputeCase(ROOM, bounty.bountyId, { viewer: POSTER }), null);
});

test("upheld ruling: resolution and case file state the full bond consequences truthfully", () => {
  const escrow = makeEscrow();
  const bounty = runToAccepted(escrow);
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: POSTER, bond: 1, grounds: GROUNDS });
  const { bounty: settled, resolution } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: DECIDER, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  // The decider's stated basis survives on the resolution.
  assert.deepEqual(resolution.reasonCodes, ["criterion-unmet"]);
  // A bond WAS forfeited in this outcome: the worker's claim bond went to the pool.
  assert.equal(resolution.bondForfeited, true);
  assert.deepEqual(resolution.bondConsequences, {
    disputeBond: { amount: 1, disposition: "returned-to-challenger", from: POSTER, to: POSTER },
    claimBond: { amount: 1, disposition: "forfeited-to-pool", from: WORKER, to: "pool" },
  });
  assert.equal(settled.resolution.bondForfeited, true);
  const caseFile = escrow.getDisputeCase(ROOM, bounty.bountyId, { viewer: WORKER });
  assert.equal(caseFile.outcome, "upheld");
  assert.deepEqual(caseFile.reasonCodes, ["criterion-unmet"]);
  assert.deepEqual(caseFile.bondConsequences, resolution.bondConsequences);
  assert.equal(escrow.balances(ROOM, "pool").payable, 1); // the forfeited claim bond
  assert.equal(escrow.balances(ROOM, POSTER).payable, 100); // refund 4 + dispute bond returned
  expectConserved(escrow);
});

test("timeout-default: the dispute bond forfeits to the pool — and the resolution says so", () => {
  const escrow = makeEscrow();
  const bounty = runToAccepted(escrow);
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: POSTER, bond: 1, grounds: GROUNDS });
  tick(15 * 24 * 3_600_000); // past the 14-day dispute timeout; nobody ruled
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(action, "released");
  const { resolution } = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(resolution.outcome, "timeout-default");
  assert.equal(resolution.bondForfeited, true);
  assert.deepEqual(resolution.bondConsequences.disputeBond,
    { amount: 1, disposition: "forfeited-to-pool", from: POSTER, to: "pool" });
  assert.equal(escrow.balances(ROOM, "pool").payable, 1);
  expectConserved(escrow);
});

test("HTTP: GET .../dispute serves the case file to every party (non-party refusal is kernel-pinned above)", async t => {
  const fixture = createAcceptanceFixture();
  const escrow = new BountyEscrow(fixture.store, { allowLegacyStringLanes: true });
  fixture.store.transaction(() => {
    escrow._ensure();
    const at = new Date().toISOString();
    for (const memberId of ["owner", "guest", "producer", "reviewer"])
      escrow._append({ roomId: "commons", accountId: memberId, at, kind: "genesis",
        amount: 100 * 1000, lotState: "payable", memo: "test seeding", actor: { kind: "rule", id: "test" } });
  });
  ensureSpendGrantsSchema(fixture.store.db);
  for (const memberId of ["producer", "reviewer"])
    issueSpendGrant(fixture.store.db, "commons", memberId,
      { grantedBy: "owner", capCents: "100000", perTxCapCents: "100000", nowMs: Date.now() });
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const keys = fixture.keys;
  const post = (path, body, secret) => fetch(`${origin}${path}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
  const get = (path, secret) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  const base = `/api/rooms/commons/bounties`;
  const created = await (await post(base, { title: "T", criteria: "C", amount: 100,
    deadline: new Date(Date.now() + 86400000).toISOString(), verifierId: "reviewer" }, keys.owner)).json();
  const bountyId = created.bounty.bountyId;
  // No dispute yet: the case file read is a plain 404, not the old 405.
  assert.equal((await get(`${base}/${bountyId}/dispute`, keys.owner)).status, 404);
  await post(`${base}/${bountyId}/fund`, {}, keys.owner);
  await post(`${base}/${bountyId}/claim`, {}, keys.producer);
  await post(`${base}/${bountyId}/submit`, { evidenceUrl: "https://example.invalid/w", summary: "short" }, keys.producer);
  await post(`${base}/${bountyId}/accept`, { verifierAttestation:
    { citations: [{ criterionId: "c1", verdict: "pass" }] } }, keys.owner);
  // The challenger is a third member (the guest): over HTTP the fixture's
  // reviewer is not independent of the owner-challenger, so — exactly as
  // in production — seating would refuse a poster-raised dispute here;
  // the poster-raised shape is pinned at kernel level above.
  const opened = await post(`${base}/${bountyId}/dispute`, { bond: 25, grounds: GROUNDS }, keys.guest);
  assert.equal(opened.status, 201);
  assert.equal((await opened.json()).dispute.grounds, GROUNDS);
  // Poster, worker, challenger and decider can all read the case — grounds included.
  for (const secret of [keys.owner, keys.producer, keys.guest, keys.reviewer]) {
    const res = await get(`${base}/${bountyId}/dispute`, secret);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dispute.grounds, GROUNDS);
    assert.equal(body.dispute.decider, "reviewer");
    assert.equal(body.dispute.bondConsequences.disputeBond.disposition, "locked");
  }
  // After a rejected ruling the case file states the bond consequence.
  const decided = await post(`${base}/${bountyId}/dispute/decide`,
    { outcome: "rejected", reasonCodes: ["evidence-insufficient"] }, keys.reviewer);
  assert.equal(decided.status, 200);
  const decidedBody = await decided.json();
  assert.deepEqual(decidedBody.resolution.reasonCodes, ["evidence-insufficient"]);
  assert.equal(decidedBody.resolution.bondConsequences.disputeBond.disposition, "compensated-to-worker");
  const after = await (await get(`${base}/${bountyId}/dispute`, keys.owner)).json();
  assert.equal(after.dispute.outcome, "rejected");
  assert.deepEqual(after.dispute.reasonCodes, ["evidence-insufficient"]);
});

test("rejected ruling: the poster's bond compensates the worker — and the surfaces say so", () => {
  const escrow = makeEscrow();
  const bounty = runToAccepted(escrow);
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: POSTER, bond: 1, grounds: GROUNDS });
  const { resolution } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: DECIDER, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.deepEqual(resolution.reasonCodes, ["evidence-insufficient"]);
  assert.equal(resolution.bondForfeited, false); // nothing was forfeited in this outcome
  assert.deepEqual(resolution.bondConsequences, {
    disputeBond: { amount: 1, disposition: "compensated-to-worker", from: POSTER, to: WORKER },
    // The ruling does not settle the worker's claim bond: it stays locked
    // until the challenge window closes — the surface must say that, not hide it.
    claimBond: { amount: 1, disposition: "still-locked", from: WORKER, to: null },
  });
  const caseFile = escrow.getDisputeCase(ROOM, bounty.bountyId, { viewer: POSTER });
  assert.equal(caseFile.bondConsequences.disputeBond.disposition, "compensated-to-worker");
  // Worker payable: 99 after the claim bond locked, +1 bond compensation.
  assert.equal(escrow.balances(ROOM, WORKER).payable, 100);
  assert.equal(escrow.balances(ROOM, POSTER).payable, 95); // bond gone to the worker
  expectConserved(escrow);
});
