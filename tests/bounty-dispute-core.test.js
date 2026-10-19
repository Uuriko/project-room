// DISPUTE-CORE acceptance tests: disputability as a posting-time property.
//
// Chartered from UT-TWO-PARTY (2026-10-19), whose live two-party journey
// found that a bounty in a two-person room could never be disputed and the
// failure surfaced only at dispute time:
//   F-2  no designation at posting -> dispute refuses dispute_unavailable,
//        with no warning at create/fund/accept and no way to add a decider.
//   F-3  claimant named as verifierId at posting -> create accepted it; the
//        dispute then refused "verifier is the executor" with a hint
//        ("correct the named fields and resend") that cannot be followed.
//   D1   (register DATA-STATE-CENSUS) a dispute timeout-default leaves the
//        dispute record `adjudicating` forever while the bounty pays out —
//        graded by the probe test at the bottom of this file.
//
// The fix exercised here: postBounty returns a no_dispute_decider warning
// when neither a verifier nor a dispute decider is designated; claimBounty
// refuses a claim by the designated verifier/decider before the bond locks;
// both doors (HTTP routes, MCP full profile) accept disputeDeciderId; the
// human create form offers a decider picker; agentErrorAx maps
// dispute_unavailable to a followable no-retry answer.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { handleBountyEscrow } from "../server/bounty-escrow-routes.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";
import { agentErrorAx, validAgentNext } from "../src/agent-error.mjs";
import { bountyBoardModel, bountyFormHtml, buildPostPayload, deciderOptionsFor } from "../src/bounty-board.js";

const ROOM = "room-dispute-core";
const JILL = "id:agent/jill";         // poster lane
const GROK = "id:agent/grokbot";      // worker lane
const INSTINCT = "id:agent/instinct"; // verifier / challenger lane
const CODEX = "id:agent/codex";       // decider / challenger lane
const OWNER = "owner-human";          // human member (route-level tests)

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const DAY = 24 * 3_600_000;

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT dispute_core_test");
    try { const out = fn(); db.exec("RELEASE dispute_core_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO dispute_core_test"); db.exec("RELEASE dispute_core_test"); throw error; }
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
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(30 * DAY), ...overrides });

function runToAccepted(escrow, overrides = {}) {
  const { bounty } = post(escrow, overrides);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// --- the happy path: designation at posting makes a dispute openable --------

test("a dispute opens on a properly designated bounty and the designated verifier rules", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { verifierId: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: JILL, bond: 2.5, grounds: "the work does not meet c1" });
  assert.equal(dispute.decider, INSTINCT);
  assert.equal(dispute.unavailable, null);
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "adjudicating");
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.state, "refunded");
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "resolved");
  expectConserved(escrow);
});

test("a disputeDecider-only designation (no verifier) also opens and seats the decider", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { disputeDeciderId: CODEX });
  assert.equal(bounty.verifier, null);
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: INSTINCT, bond: 2.5, grounds: "bad work" });
  assert.equal(dispute.decider, CODEX);
  expectConserved(escrow);
});

// --- create-time validation -------------------------------------------------

test("poster-as-verifier and poster-as-decider are refused at create", () => {
  const { escrow } = makeEscrow();
  expectCode(() => post(escrow, { verifierId: JILL }), "invalid_input");
  expectCode(() => post(escrow, { disputeDeciderId: JILL }), "invalid_input");
  // A verifier who is not one of the room's lanes at all is refused too.
  expectCode(() => post(escrow, { verifierId: "id:agent/nobody" }), "invalid_input");
  expectConserved(escrow);
});

test("posting with no designation succeeds WITH the no_dispute_decider warning; designations silence it", () => {
  const { escrow } = makeEscrow();
  const plain = post(escrow, {});
  assert.equal(plain.bounty.state, "proposed");
  assert.equal(plain.warnings.length, 1);
  assert.equal(plain.warnings[0].code, "no_dispute_decider");
  assert.match(plain.warnings[0].message, /can never be disputed/);
  assert.match(plain.warnings[0].message, /cannot be added later/);
  assert.deepEqual(post(escrow, { verifierId: INSTINCT }).warnings, []);
  assert.deepEqual(post(escrow, { disputeDeciderId: CODEX }).warnings, []);
  expectConserved(escrow);
});

// --- claim-time independence guard (the F-3 cure) ---------------------------

test("the designated verifier cannot claim: refused before the claim bond locks", () => {
  const { escrow } = makeEscrow();
  const { bounty } = post(escrow, { amount: 4, verifierId: GROK });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const before = bal(escrow, GROK);
  const error = expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }), "not_authorized");
  assert.match(error.message, /designated verifier/);
  assert.match(error.message, /independent of the executor/);
  // Nothing moved: the bounty is still funded and unclaimed, no bond locked.
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "funded");
  assert.equal(after.claimant, null);
  assert.deepEqual(bal(escrow, GROK), before);
  expectConserved(escrow);
});

test("the designated dispute decider cannot claim either", () => {
  const { escrow } = makeEscrow();
  const { bounty } = post(escrow, { amount: 4, disputeDeciderId: GROK });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const before = bal(escrow, GROK);
  const error = expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }), "not_authorized");
  assert.match(error.message, /designated dispute decider/);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "funded");
  assert.deepEqual(bal(escrow, GROK), before);
  // And a third lane can still claim the same bounty.
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: INSTINCT });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).claimant, INSTINCT);
  expectConserved(escrow);
});

// --- HTTP door: disputeDeciderId accepted, warnings ride the 201 ------------

class HttpReject extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const routeHelpers = {
  json: (res, status, value) => { res.statusCode = status; res.body = value; },
  reject: (status, code, message) => { throw new HttpReject(status, code, message); },
  body: async req => req._body,
};
function makeRouteStore() {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  const transaction = fn => {
    db.exec("SAVEPOINT dispute_core_routes");
    try { const out = fn(); db.exec("RELEASE dispute_core_routes"); return out; }
    catch (error) { db.exec("ROLLBACK TO dispute_core_routes"); db.exec("RELEASE dispute_core_routes"); throw error; }
  };
  const members = {
    [JILL]: { kind: "agent", active: true },
    [GROK]: { kind: "agent", active: true },
    [INSTINCT]: { kind: "agent", active: true },
    [OWNER]: { kind: "human", active: true },
  };
  const store = { db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: OWNER, members }),
    agentPlugin: { fanoutRoomEvent: () => {} } };
  store.bountyEscrow = new BountyEscrow(store, { now: () => nowMs });
  return store;
}
const callRoute = async (store, { route, bodyData = {}, authId = JILL, bountyId = null }) => {
  const req = { method: "POST", headers: {}, _body: bodyData };
  const res = { statusCode: null, body: null };
  const auth = { member: { id: authId, kind: authId.startsWith("id:agent/") ? "agent" : "human" } };
  try {
    await handleBountyEscrow({ req, res, url: new URL(`http://localhost/api/rooms/${ROOM}/x`), store,
      roomId: ROOM, auth, escrowRoute: route, bountyId, identity: null, sybilFlagId: null,
      reauthorize: () => auth, helpers: routeHelpers, credential: null });
  } catch (error) {
    if (error instanceof HttpReject) { res.statusCode = error.status; res.body = { code: error.code, message: error.message }; }
    else throw error;
  }
  return res;
};
const routeBody = (overrides = {}) => ({ title: "T", criteria: "C", amount: 10,
  deadline: isoFuture(30 * DAY), ...overrides });

test("HTTP create accepts a human disputeDeciderId, and warns when none is named", async () => {
  const store = makeRouteStore();
  const designated = await callRoute(store, { route: "create", bodyData: routeBody({ disputeDeciderId: OWNER }) });
  assert.equal(designated.statusCode, 201);
  assert.equal(designated.body.bounty.disputeDecider, OWNER);
  assert.deepEqual(designated.body.warnings, []);
  const plain = await callRoute(store, { route: "create", bodyData: routeBody() });
  assert.equal(plain.statusCode, 201);
  assert.equal(plain.body.warnings.length, 1);
  assert.equal(plain.body.warnings[0].code, "no_dispute_decider");
  const selfNamed = await callRoute(store, { route: "create", bodyData: routeBody({ disputeDeciderId: JILL }) });
  assert.equal(selfNamed.statusCode, 422);
  assert.equal(selfNamed.body.code, "invalid_input");
});

test("HTTP claim by the designated decider is refused 403 before any bond locks", async () => {
  const store = makeRouteStore();
  const created = await callRoute(store, { route: "create", bodyData: routeBody({ disputeDeciderId: GROK }) });
  assert.equal(created.statusCode, 201);
  const bountyId = created.body.bounty.bountyId;
  const funded = await callRoute(store, { route: "fund", bountyId });
  assert.equal(funded.statusCode, 200);
  const claim = await callRoute(store, { route: "claim", bountyId, authId: GROK });
  assert.equal(claim.statusCode, 403);
  assert.equal(claim.body.code, "not_authorized");
  assert.match(claim.body.message, /designated dispute decider/);
});

// --- agent error surface: the hint must be followable -----------------------

test("agentErrorAx: dispute_unavailable never advises correcting fields and resending", () => {
  const ax = agentErrorAx({ httpStatus: 422, code: "dispute_unavailable",
    message: "dispute is unavailable for this bounty: no designated decider — a dispute needs a dispute decider (or verifier) named at posting to seat its decider" });
  assert.equal(ax.reason, "dispute_unavailable");
  assert.doesNotMatch(ax.hint, /[Cc]orrect the named fields/);
  assert.match(ax.hint, /named at posting/);
  assert.ok(ax.hint.length < 160, "hint stays short");
  assert.ok(validAgentNext(ax.next), "next[] stays followable");
  assert.match(ax.next[0].command, /Do not retry/);
});

// --- human create form: the decider picker ----------------------------------

test("decider options exclude the poster and inactive members, prefer display names", () => {
  const members = {
    [JILL]: { id: JILL, displayName: "Jill", active: true },
    [GROK]: { id: GROK, displayName: "Grok Bot", active: true },
    [INSTINCT]: { id: INSTINCT, active: true },
    [CODEX]: { id: CODEX, displayName: "Codex", active: false },
  };
  const options = deciderOptionsFor(members, JILL);
  assert.deepEqual(options.map(o => o.id), [GROK, INSTINCT]);
  assert.equal(options[0].label, "Grok Bot");
  assert.equal(options[1].label, INSTINCT);
  const model = bountyBoardModel({ bounties: [], balances: {}, receipts: [], selfId: JILL, members });
  assert.deepEqual(model.deciderOptions, options);
});

test("the create form renders the decider picker with the plain consequence as the default", () => {
  const html = bountyFormHtml(1_786_000_000_000, [{ id: GROK, label: "Grok Bot" }]);
  assert.match(html, /id="bounty-dispute-decider"/);
  assert.match(html, /No one — this bounty can never be disputed/);
  assert.match(html, new RegExp(`<option value="${GROK}">Grok Bot</option>`));
  assert.match(html, /cannot be added later/);
});

test("buildPostPayload carries disputeDeciderId only when one is picked", () => {
  const base = { title: "T", criteria: "C", amount: 5, deadlineLocal: "2999-01-01T00:00" };
  assert.equal(buildPostPayload({ ...base, disputeDeciderId: GROK }).disputeDeciderId, GROK);
  assert.equal("disputeDeciderId" in buildPostPayload({ ...base, disputeDeciderId: "" }), false);
  assert.equal("disputeDeciderId" in buildPostPayload(base), false);
});

// --- D1 probe (register DATA-STATE-CENSUS): grade, do not fix ---------------
//
// D1 as recorded: "a dispute timeout-default leaves the dispute record
// adjudicating forever while the bounty pays out". Mechanism at this base:
// _keeperPass's timeout branch calls _settleDispute directly — the bounty
// settles (verdict recorded, award vests, sweep pays) but the dispute
// MACHINE record is never transitioned out of `adjudicating`. This probe
// executes the full path and asserts BOTH halves, so the grade is
// behavioural, not a code read. If a future fix transitions the record, the
// last assertion flips and the register row can be closed.
test("D1 probe: the 14-day timeout-default pays the worker while the dispute record stays adjudicating", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 4, verifierId: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 1, grounds: "meh" });
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "adjudicating");
  tick(15 * DAY);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(action, "released");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).resolution.outcome, "timeout-default");
  escrow.closeEpoch(ROOM, {});
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.state, "paid", "the bounty fully settles and pays out");
  assert.equal(bal(escrow, GROK).payable, 103.96, "worker received the award net of the 1% pool fee, claim bond home");
  // D1 REPRODUCES at this base: the record is still parked in adjudicating
  // even though its bounty is paid and its money has all moved.
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "adjudicating",
    "D1: dispute record remains adjudicating forever after a timeout-default");
  expectConserved(escrow);
});
