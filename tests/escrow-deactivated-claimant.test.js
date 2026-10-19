// ESCROW-GUARDS PR 2 (HUNT state-machine F3 sibling / ATLAS-WORK-MONEY):
// settlement could pay a claimant whose membership had been deactivated
// (identity unlink sets active:false; the member record persists). The
// action doors refuse a deactivated member (_requireLane), but no
// settlement path re-checked the RECIPIENT. These tests pin the guard:
// earnings settlements to a deactivated claimant refuse with
// claimant_deactivated and the funds stay in escrow; poster refunds and
// claim-bond returns (the claimant's own collateral) are deliberately NOT
// guarded, so a deactivation can never wedge another party's money.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { handleBountyEscrow } from "../server/bounty-escrow-routes.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const ROOM = "room-escrow-guards";
const JILL = "id:agent/jill";        // poster
const GROK = "id:agent/grokbot";     // worker / claimant
const INSTINCT = "id:agent/instinct";// verifier / decider
const CODEX = "id:agent/codex";      // challenger
const OWNER = "owner-human";
const DAY_MS = 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld() {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_guards_test");
    try { const out = fn(); db.exec("RELEASE escrow_guards_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_guards_test"); db.exec("RELEASE escrow_guards_test"); throw error; }
  };
  const members = {
    [JILL]: { kind: "agent", active: true },
    [GROK]: { kind: "agent", active: true },
    [INSTINCT]: { kind: "agent", active: true },
    [CODEX]: { kind: "agent", active: true },
    [OWNER]: { kind: "human", active: true },
  };
  const store = { db, transaction, readTransaction: transaction, now: () => nowMs,
    roomAuthority: () => ({ ownerId: OWNER, members }) };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { store, db, escrow, members };
}

const bal = (escrow, lane) => escrow.balances(ROOM, lane);
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
// Deactivation as the product performs it: unlink leaves the member record
// in place with active:false (state-machine.md identity unlink semantics).
const deactivate = (world, lane) => { world.members[lane] = { ...world.members[lane], active: false }; };
const reactivate = (world, lane) => { world.members[lane] = { ...world.members[lane], active: true }; };

function runToAccepted(world, { amount = 10, verifier = null } = {}) {
  const { escrow } = world;
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(30 * DAY_MS), verifierId: verifier }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}
const runToApproved = world => {
  const bounty = runToAccepted(world);
  tick(4 * DAY_MS); // past the 3-day challenge window
  const fin = world.escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  assert.equal(fin.action, "approved");
  return world.escrow.getBounty(ROOM, bounty.bountyId);
};
const runToDisputed = world => {
  const bounty = runToAccepted(world, { verifier: INSTINCT });
  world.escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "looks wrong" });
  return world.escrow.getBounty(ROOM, bounty.bountyId);
};

test("epoch sweep refuses a deactivated claimant: funds stay in escrow, failure is on the epoch record", () => {
  const world = makeWorld(), { escrow } = world;
  const bounty = runToApproved(world);
  assert.equal(bal(escrow, GROK).payable, 99);      // genesis minus the locked claim bond
  assert.equal(bal(escrow, GROK).approved, 10);
  deactivate(world, GROK);
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch.summary.swept, []);
  assert.equal(epoch.summary.failed.length, 1);
  assert.equal(epoch.summary.failed[0].bountyId, bounty.bountyId);
  assert.equal(epoch.summary.failed[0].code, "claimant_deactivated");
  // Nothing moved: bounty still approved, award still vested, bond still locked.
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "approved");
  assert.equal(bal(escrow, GROK).payable, 99);
  assert.equal(bal(escrow, GROK).approved, 10);
  assert.equal(bal(escrow, GROK).locked, 1);
  assert.equal(bal(escrow, "pool").payable, 0);
  expectConserved(escrow);
});

test("reactivating the claimant lets the same settlement pay exactly", () => {
  const world = makeWorld(), { escrow } = world;
  const bounty = runToApproved(world);
  deactivate(world, GROK);
  escrow.closeEpoch(ROOM, { caller: JILL });
  reactivate(world, GROK); // re-link: same member record, active again
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch.summary.swept, [bounty.bountyId]);
  assert.deepEqual(epoch.summary.failed ?? [], []); // summary.failed is lazy: absent when nothing failed
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  assert.equal(bal(escrow, GROK).payable, 99 + 9.9 + 1); // net award + claim bond home
  assert.equal(bal(escrow, "pool").payable, 0.1);        // 1% fee
  expectConserved(escrow);
});

test("dispute RELEASE refuses a deactivated worker atomically; the decision can be re-taken after reactivation", () => {
  const world = makeWorld(), { escrow } = world;
  const bounty = runToDisputed(world);
  const codexBefore = bal(escrow, CODEX), grokBefore = bal(escrow, GROK);
  deactivate(world, GROK);
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] }), "claimant_deactivated");
  // Atomic refusal: bounty still disputed, no verdict recorded, no money moved.
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "disputed");
  assert.equal(after.resolution, null);
  assert.deepEqual(bal(escrow, CODEX), codexBefore); // challenger bond still locked
  assert.deepEqual(bal(escrow, GROK), grokBefore);
  expectConserved(escrow);
  // After reactivation the decider re-takes the same decision and it settles.
  reactivate(world, GROK);
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(settled.resolution.kind, "release");
  escrow.closeEpoch(ROOM, {});
  assert.equal(bal(escrow, GROK).payable, grokBefore.payable + 2.5 + 9.9 + 1); // bond compensation + net award + bond home
  expectConserved(escrow);
});

test("dispute SPLIT refuses a deactivated worker (the vesting half is earnings)", () => {
  const world = makeWorld(), { escrow } = world;
  const bounty = runToDisputed(world);
  deactivate(world, GROK);
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] }), "claimant_deactivated");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  expectConserved(escrow);
});

test("dispute CANCEL still settles with a deactivated worker: poster refund is never wedged", () => {
  const world = makeWorld(), { escrow } = world;
  const bounty = runToDisputed(world);
  deactivate(world, GROK);
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "cancel");
  assert.equal(bal(escrow, JILL).payable, 100);  // poster refunded in full
  assert.equal(bal(escrow, CODEX).payable, 100); // challenger bond returned
  assert.equal(bal(escrow, "pool").payable, 1);  // claimant's claim bond forfeited, as before
  assert.equal(bal(escrow, GROK).payable, 99);   // worker earns 0
  expectConserved(escrow);
});

test("unverified refund still settles with a deactivated claimant: poster refunded, claim bond comes home", () => {
  const world = makeWorld(), { escrow } = world;
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  tick(3600_000 + 1); // past the deadline, never verified
  deactivate(world, GROK);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  assert.equal(action, "refunded");
  assert.equal(bal(escrow, JILL).payable, 100); // poster refunded in full
  assert.equal(bal(escrow, GROK).payable, 100);  // bond returned (own collateral — unguarded by design)
  assert.equal(bal(escrow, GROK).locked, 0);
  expectConserved(escrow);
});

test("legacy string-lane mode (no membership source) settles exactly as before", () => {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT legacy_test");
    try { const out = fn(); db.exec("RELEASE legacy_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO legacy_test"); db.exec("RELEASE legacy_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  const world = { escrow };
  const bounty = runToApproved(world);
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch.summary.swept, [bounty.bountyId]);
  assert.deepEqual(epoch.summary.failed ?? [], []);
  assert.equal(bal(escrow, GROK).payable, 99 + 9.9 + 1);
  expectConserved(escrow);
});

// --- route surface: claimant_deactivated maps to HTTP 409 -------------------
class HttpReject extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const routeHelpers = {
  json: (res, status, value) => { res.statusCode = status; res.body = value; },
  reject: (status, code, message) => { throw new HttpReject(status, code, message); },
  body: async req => req._body,
};
const authFor = id => ({ member: { id, kind: id.startsWith("id:agent/") ? "agent" : "human" } });

test("route: dispute-decide on a deactivated worker surfaces 409 claimant_deactivated", async () => {
  const world = makeWorld(), { escrow, store } = world;
  const bounty = runToDisputed(world);
  deactivate(world, GROK);
  const req = { method: "POST", headers: {}, _body: { outcome: "rejected", reasonCodes: ["evidence-insufficient"] } };
  const res = { statusCode: null, body: null };
  const auth = authFor(INSTINCT);
  try {
    await handleBountyEscrow({ req, res, url: new URL(`http://localhost/api/rooms/${ROOM}/x`), store,
      roomId: ROOM, auth, escrowRoute: "dispute-decide", bountyId: bounty.bountyId,
      reauthorize: () => auth, helpers: routeHelpers });
    assert.fail(`expected a 409 rejection, got status ${res.statusCode}`);
  } catch (error) {
    assert.ok(error instanceof HttpReject, `expected HttpReject, got ${error}`);
    assert.equal(error.status, 409);
    assert.equal(error.code, "claimant_deactivated");
  }
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  expectConserved(escrow);
});
