// Sponsor exits (Option A, money-adjacent): poster-initiated unfund of a
// funded, unclaimed bounty, and the proposed-state delete (the sponsor
// name for the decline kernel path). These tests ARE the charter §6
// acceptance probes, including lane 09-07's staged cells (a)-(d):
//   (a) funded, never claimed -> reclaim: now answers "unfund, full
//       amount, immediate"; the staged verb set still has no other exit.
//   (b) funded, claimed, worker silent -> unfund refuses with the
//       enumeration; the reclaim leg that applies is deadline finalize.
//   (c) funded, submitted, sponsor does nothing -> unfund refuses;
//       nothing moves.
//   (d) deadline interplay: an unfunded bounty is terminal, so the
//       deadline machinery (finalize / epoch close) is a no-op for it.
// Conservation is asserted after every journey (verifyConservation plus
// byte-identical balance read-backs), per charter §4.2: conservation
// tests are acceptance, not optional.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner, verifyBountyReceipt } from "../server/bounty-receipts.mjs";
import { handleBountyEscrow } from "../server/bounty-escrow-routes.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { issueSpendGrant } from "../server/spend-grants.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";        // poster lane
const GROK = "id:agent/grokbot";     // worker lane
const INSTINCT = "id:agent/instinct"; // verifier lane
const CODEX = "id:agent/codex";      // challenger lane

function makeEscrow({ signer = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT unfund_test");
    try { const out = fn(); db.exec("RELEASE unfund_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO unfund_test"); db.exec("RELEASE unfund_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  let nowMs = 1_786_000_000_000;
  const receipts = signer
    ? createReceiptSigner({ seedHex: "9d61b19deffd5a60ba844af492ec2af44449c5697b326919703bac031cae7f60", ref: "test-operator" })
    : null;
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true, receipts });
  escrow.ensureGenesis(ROOM);
  return { escrow, db, tick: ms => { nowMs += ms; }, now: () => nowMs };
}

const bal = (escrow, lane) => escrow.balances(ROOM, lane);
const expectConserved = escrow => assert.equal(escrow.verifyConservation(ROOM).ok, true);
const expectRefusal = (fn, pattern) => {
  try { fn(); } catch (error) {
    assert.equal(error.code, "invalid_state", `expected invalid_state, got ${error.code}: ${error.message}`);
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail("expected invalid_state refusal, no error thrown");
};
const postFunded = (escrow, now, { amount = 5, deadlineMs = 3_600_000 } = {}) => {
  const { bounty } = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: new Date(now() + deadlineMs).toISOString() });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  return escrow.getBounty(ROOM, bounty.bountyId);
};
const journalKinds = db => [...new Set(db.prepare("SELECT DISTINCT kind FROM bounty_journal WHERE room_id=?").all(ROOM).map(r => r.kind))].sort();

// --- §6.1 / cell (a): funded, never claimed ---------------------------------

test("cell (a): fund 5 -> unfund -> full refund immediately, balances byte-identical to pre-fund, no fee", () => {
  const { escrow, db, now } = makeEscrow();
  const preFund = bal(escrow, JILL), prePool = bal(escrow, "pool");
  const bounty = postFunded(escrow, now, { amount: 5 });
  assert.equal(bal(escrow, JILL).locked, 5);
  const { bounty: after, settlement, receipt } = escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL });
  assert.equal(after.state, "refunded");
  assert.equal(after.group, "cancelled");
  assert.deepEqual(settlement, { ...settlement, kind: "poster-withdrawn", workerMillis: 0, refundMillis: 5000 });
  assert.match(settlement.reason, /poster withdrew the funded bounty before any claim/);
  assert.equal(receipt.kind, "unfund");
  assert.deepEqual(bal(escrow, JILL), preFund);
  assert.deepEqual(bal(escrow, "pool"), prePool); // no fee leg
  assert.deepEqual(journalKinds(db), ["escrow-lock", "genesis", "refund"]); // no new journal kind
  // History shows lock + refund movements and the unfund event.
  const history = escrow.history(ROOM, JILL, {});
  assert.ok(history.some(r => r.kind === "refund"));
  const events = escrow.listEvents(ROOM, {});
  const ev = events.find(e => e.type === "bounty.refunded" && e.bountyId === bounty.bountyId);
  assert.equal(ev.before, "funded"); assert.equal(ev.after, "refunded");
  assert.equal(ev.data.reason, "poster-withdrawn");
  assert.equal(ev.actor.id, JILL);
  expectConserved(escrow);
});

test("unfund with a signer: the refund receipt verifies and names poster-withdrawn (H-21 shape)", () => {
  const { escrow, now } = makeEscrow({ signer: true });
  const bounty = postFunded(escrow, now, { amount: 5 });
  const { receipt } = escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL, reason: "wrong amount" });
  assert.equal(receipt.signed.length, 1);
  assert.equal(verifyBountyReceipt(receipt.signed[0]).ok, true);
  assert.equal(receipt.signed[0].payload.reason, "poster-withdrawn");
  const ev = escrow.listEvents(ROOM, {}).find(e => e.type === "bounty.refunded");
  assert.equal(ev.data.posterReason, "wrong amount");
  expectConserved(escrow);
});

test("unfund is poster-only and names unknown bounties", () => {
  const { escrow, now } = makeEscrow();
  const bounty = postFunded(escrow, now);
  assert.throws(() => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: GROK }),
    e => e.code === "not_authorized" && /only the poster may unfund/.test(e.message));
  assert.throws(() => escrow.unfundBounty(ROOM, "ROOMTEST-99", { unfunder: JILL }), e => e.code === "unknown_bounty");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "funded");
  assert.equal(bal(escrow, JILL).locked, 5);
  expectConserved(escrow);
});

// --- §6.3: the refusal family, with read-back after every refusal -----------

test("unfund from proposed points at the delete shape by name; nothing moves", () => {
  const { escrow, now } = makeEscrow();
  const pre = bal(escrow, JILL);
  const { bounty } = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 5, deadline: new Date(now() + 3_600_000).toISOString() });
  expectRefusal(() => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL }), /proposed.*nothing is locked.*bounty_delete/);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "proposed");
  assert.deepEqual(bal(escrow, JILL), pre);
  expectConserved(escrow);
});

test("cell (b): unfund from claimed refuses with state, amount, claimant and the paths that apply; bond untouched", () => {
  const { escrow, now, tick } = makeEscrow();
  const bounty = postFunded(escrow, now, { amount: 5, deadlineMs: 60_000 });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  const posterPre = bal(escrow, JILL), workerPre = bal(escrow, GROK);
  const err = expectRefusal(() => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL }),
    /claimed: 5 credits stay locked while id:agent\/grokbot holds the claim/);
  assert.match(err.message, /deadline and finalize/);
  assert.match(err.message, /dispute machinery/);
  assert.deepEqual(bal(escrow, JILL), posterPre);
  assert.deepEqual(bal(escrow, GROK), workerPre); // claim bond untouched
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "claimed");
  expectConserved(escrow);
  // Cell (b)'s applicable leg: after the deadline, finalize refunds in full.
  tick(120_000);
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  assert.equal(fin.action, "refunded");
  assert.equal(bal(escrow, JILL).payable, 100);
  expectConserved(escrow);
});

test("cell (c): unfund from submitted refuses; sponsor inaction leaves the escrow exactly as it was", () => {
  const { escrow, now } = makeEscrow();
  const bounty = postFunded(escrow, now, { amount: 5 });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const posterPre = bal(escrow, JILL), workerPre = bal(escrow, GROK);
  expectRefusal(() => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL }),
    /submitted: 5 credits stay locked.*accept or reject/);
  assert.deepEqual(bal(escrow, JILL), posterPre);
  assert.deepEqual(bal(escrow, GROK), workerPre);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  expectConserved(escrow);
});

test("unfund refuses from accepted, disputed, approved and every terminal state, naming state + path", () => {
  const { escrow, now, tick } = makeEscrow();
  const runToAccepted = () => {
    // A designated verifier seats the dispute decider, so the disputed
    // leg below can open (a default bounty has no decider to seat).
    const { bounty: proposed } = escrow.postBounty(ROOM,
      { poster: JILL, title: "T", criteria: "C", amount: 10, verifierId: INSTINCT, deadline: new Date(now() + 3_600_000).toISOString() });
    escrow.fundBounty(ROOM, proposed.bountyId, { funder: JILL });
    const bounty = escrow.getBounty(ROOM, proposed.bountyId);
    escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
    escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
      evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
    escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
      verifierAttestation: { at: new Date(now()).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
    return escrow.getBounty(ROOM, bounty.bountyId);
  };
  const accepted = runToAccepted();
  expectRefusal(() => escrow.unfundBounty(ROOM, accepted.bountyId, { unfunder: JILL }), /accepted: 10 credits are attributed/);
  escrow.disputeBounty(ROOM, accepted.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
  expectRefusal(() => escrow.unfundBounty(ROOM, accepted.bountyId, { unfunder: JILL }), /disputed: finality is frozen/);
  expectConserved(escrow);

  const second = runToAccepted();
  tick(3 * 24 * 3600 * 1000 + 1000); // challenge window elapses
  escrow.finalizeBounty(ROOM, second.bountyId, { caller: JILL }); // accepted -> approved
  assert.equal(escrow.getBounty(ROOM, second.bountyId).state, "approved");
  expectRefusal(() => escrow.unfundBounty(ROOM, second.bountyId, { unfunder: JILL }), /approved: the 10 credits have vested/);
  escrow.closeEpoch(ROOM, { caller: JILL }); // approved -> paid (the epoch sweep leg)
  assert.equal(escrow.getBounty(ROOM, second.bountyId).state, "paid");
  expectRefusal(() => escrow.unfundBounty(ROOM, second.bountyId, { unfunder: JILL }), /paid \(terminal\): nothing to unfund/);
  expectConserved(escrow);
});

test("cell (d): unfund before the deadline makes the deadline machinery a no-op", () => {
  const { escrow, now, tick } = makeEscrow();
  const pre = bal(escrow, JILL);
  const bounty = postFunded(escrow, now, { amount: 5, deadlineMs: 60_000 });
  escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL });
  tick(120_000); // deadline passes
  expectRefusal(() => escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL }), /nothing to finalize/);
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.ok(!epoch.summary.refunded.includes(bounty.bountyId));
  assert.ok(!epoch.summary.expiredUnfunded.includes(bounty.bountyId));
  assert.deepEqual(bal(escrow, JILL), pre);
  expectConserved(escrow);
});

// --- §4.5 idempotency --------------------------------------------------------

test("idempotent replay returns the original receipt with no second movement; a distinct second unfund refuses naming the terminal state", () => {
  const { escrow, db, now } = makeEscrow();
  const bounty = postFunded(escrow, now, { amount: 5 });
  const scope = { callerLane: JILL, bountyId: bounty.bountyId, payload: {} };
  const first = escrow.idemExecute(ROOM, "unfund-1", "bounty.unfund", 200,
    () => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL }), scope);
  assert.equal(first.replayed, false);
  const rowsAfterFirst = db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND kind='refund'").get(ROOM).n;
  const replay = escrow.idemExecute(ROOM, "unfund-1", "bounty.unfund", 200,
    () => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL }), scope);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body.receipt, first.body.receipt);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE room_id=? AND kind='refund'").get(ROOM).n, rowsAfterFirst);
  expectRefusal(() => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL }), /refunded \(terminal\): nothing to unfund/);
  expectConserved(escrow);
});

// --- §4.7 race: claim vs unfund, both orders ---------------------------------
// The store transaction is synchronous and serialised, so the race
// resolves by whichever transaction commits first; the test drives both
// orders (the only two interleavings a serialised store admits) and
// asserts exactly one winner and a loser refusal naming the end state.

test("race, unfund first: the claim then refuses naming the refunded state", () => {
  const { escrow, now } = makeEscrow();
  const bounty = postFunded(escrow, now, { amount: 5 });
  escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL });
  assert.throws(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }),
    e => e.code === "invalid_state" && /bounty is refunded, not open for claims/.test(e.message));
  assert.equal(bal(escrow, JILL).payable, 100);
  assert.equal(bal(escrow, GROK).locked, 0); // no bond was locked by the losing claim
  expectConserved(escrow);
});

test("race, claim first: the unfund then refuses naming the claimed state; watchers see exactly one terminal event", () => {
  const { escrow, now } = makeEscrow();
  const bounty = postFunded(escrow, now, { amount: 5 });
  escrow.watchBounty(ROOM, bounty.bountyId, { watcher: GROK });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  expectRefusal(() => escrow.unfundBounty(ROOM, bounty.bountyId, { unfunder: JILL }), /claimed: 5 credits/);
  const terminalEvents = escrow.listEvents(ROOM, {})
    .filter(e => e.bountyId === bounty.bountyId && ["bounty.refunded", "bounty.paid"].includes(e.type));
  assert.equal(terminalEvents.length, 0); // no terminal event: the bounty lives on as claimed
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "claimed");
  expectConserved(escrow);
});

// --- §6.2: the proposed-state delete -----------------------------------------

test("proposed delete: gone from the active list, present as cancelled with actor + default reason; decline unchanged", () => {
  const { escrow, now } = makeEscrow();
  const { bounty } = escrow.postBounty(ROOM,
    { poster: JILL, title: "Typo'd draft", criteria: "C", amount: 5, deadline: new Date(now() + 3_600_000).toISOString() });
  const { bounty: deleted, receipt } = escrow.deleteBounty(ROOM, bounty.bountyId, { deleter: JILL });
  assert.equal(deleted.state, "cancelled");
  assert.equal(deleted.declineReason, "poster deleted own proposed bounty");
  assert.equal(receipt.kind, "delete");
  assert.equal(receipt.actor.id, JILL);
  assert.equal(escrow.listBounties(ROOM, { group: "proposed" }).length, 0);
  assert.equal(escrow.listBounties(ROOM, { group: "cancelled" }).length, 1);
  // delete from a funded state refuses through the triage shape; unfund is the funded exit.
  const funded = postFunded(escrow, now, { amount: 5 });
  assert.throws(() => escrow.deleteBounty(ROOM, funded.bountyId, { deleter: JILL }),
    e => e.code === "invalid_state" && /not open for triage/.test(e.message));
  // decline still requires its reason and still works.
  const { bounty: second } = escrow.postBounty(ROOM,
    { poster: JILL, title: "T2", criteria: "C", amount: 5, deadline: new Date(now() + 3_600_000).toISOString() });
  assert.throws(() => escrow.declineBounty(ROOM, second.bountyId, { decliner: JILL }), e => e.code === "invalid_input");
  const declined = escrow.declineBounty(ROOM, second.bountyId, { decliner: JILL, reason: "duplicate of the first" });
  assert.equal(declined.bounty.state, "cancelled");
  assert.equal(declined.receipt.kind, "decline");
  expectConserved(escrow);
});

// --- HTTP route-handler shape -------------------------------------------------

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
    db.exec("SAVEPOINT unfund_routes");
    try { const out = fn(); db.exec("RELEASE unfund_routes"); return out; }
    catch (error) { db.exec("ROLLBACK TO unfund_routes"); db.exec("RELEASE unfund_routes"); throw error; }
  };
  const members = {
    [JILL]: { kind: "agent", active: true },
    [GROK]: { kind: "agent", active: true },
    [INSTINCT]: { kind: "agent", active: true },
  };
  const fanouts = [];
  const store = { db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: "owner-human", members }),
    agentPlugin: { fanoutRoomEvent: call => { fanouts.push(call); } } };
  store.bountyEscrow = new BountyEscrow(store, { now: () => 1_786_000_000_000 });
  return { store, fanouts };
}
const routeCall = async (store, { route, bountyId = null, authId = JILL, bodyData = {}, headers = {} }) => {
  const req = { method: "POST", headers, _body: bodyData };
  const res = { statusCode: null, body: null };
  const auth = { member: { id: authId, kind: "agent" } };
  try {
    await handleBountyEscrow({ req, res, url: new URL("http://localhost/api/rooms/room-test/x"), store,
      roomId: ROOM, auth, escrowRoute: route, bountyId, identity: null, sybilFlagId: null,
      reauthorize: () => auth, helpers: routeHelpers });
  } catch (error) {
    if (error instanceof HttpReject) { res.statusCode = error.status; res.body = { code: error.code, message: error.message }; }
    else throw error;
  }
  return res;
};
const routePostFund = async store => {
  const created = await routeCall(store, { route: "create", bodyData: {
    title: "T", criteria: "C", amount: 5, deadline: new Date(1_786_000_000_000 + 3_600_000).toISOString() } });
  assert.equal(created.statusCode, 201);
  const bountyId = created.body.bounty.bountyId;
  const funded = await routeCall(store, { route: "fund", bountyId });
  assert.equal(funded.statusCode, 200);
  return bountyId;
};

test("routes: POST unfund -> 200 with settlement; watcher fan-out fires; replay returns the original; claimed -> 422 enumeration", async () => {
  const { store, fanouts } = makeRouteStore();
  const bountyId = await routePostFund(store);
  const res = await routeCall(store, { route: "unfund", bountyId, headers: { "idempotency-key": "u-1" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bounty.state, "refunded");
  assert.equal(res.body.settlement.kind, "poster-withdrawn");
  assert.ok(fanouts.some(f => f.event.type === "bounty.refunded"), "watchers are notified via the funding fan-out");
  const replay = await routeCall(store, { route: "unfund", bountyId, headers: { "idempotency-key": "u-1" } });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.body.receipt, res.body.receipt);
  const second = await routeCall(store, { route: "unfund", bountyId, headers: { "idempotency-key": "u-2" } });
  assert.equal(second.statusCode, 422);
  assert.match(second.body.message, /refunded \(terminal\)/);

  const claimedId = await routePostFund(store);
  const claim = await routeCall(store, { route: "claim", bountyId: claimedId, authId: GROK });
  assert.equal(claim.statusCode, 200);
  const refused = await routeCall(store, { route: "unfund", bountyId: claimedId });
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.body.code, "invalid_state");
  assert.match(refused.body.message, /claimed: 5 credits stay locked/);
  const notPoster = await routeCall(store, { route: "unfund", bountyId: claimedId, authId: GROK });
  assert.equal(notPoster.statusCode, 403); // the poster gate precedes the state enumeration
  assert.equal(notPoster.body.code, "not_authorized");
});

test("routes: POST delete on a proposed bounty -> 200 cancelled; on a funded bounty -> 422", async () => {
  const { store } = makeRouteStore();
  const created = await routeCall(store, { route: "create", bodyData: {
    title: "T", criteria: "C", amount: 5, deadline: new Date(1_786_000_000_000 + 3_600_000).toISOString() } });
  const bountyId = created.body.bounty.bountyId;
  const res = await routeCall(store, { route: "delete", bountyId, bodyData: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.bounty.state, "cancelled");
  const fundedId = await routePostFund(store);
  const refused = await routeCall(store, { route: "delete", bountyId: fundedId });
  assert.equal(refused.statusCode, 422);
});

// --- §6.5 MCP parity ------------------------------------------------------------

function mcpFixture(t) {
  const store = new RoomStore(":memory:"); t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, command) => store.command(keys[actor], "commons", command);
  for (const memberId of ["agent", "worker"]) {
    send("owner", { id: `add-${memberId}`, type: "member.added",
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    keys[memberId] = store.issueAccessKey("commons", memberId);
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  issueSpendGrant(store.db, "commons", "agent", { grantedBy: "owner", capCents: "100000", perTxCapCents: "10000", nowMs: Date.now() });
  store.bountyEscrow.ensureGenesis("commons");
  return { store, keys };
}
const mcpCall = (store, keys, actor, name, args) =>
  callHostedStdioTool(store, keys[actor], name, { roomId: "commons", ...args });

test("MCP: bounty_unfund executes the same journey with the same record; bounty_delete deletes a proposal; claimed refuses identically", async t => {
  const { store, keys } = mcpFixture(t);
  const escrow = store.bountyEscrow;
  const posted = await mcpCall(store, keys, "agent", "bounty_post", {
    title: "T", criteria: "C", amount: 5, deadline: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: "mcp-post-1" });
  const bountyId = posted.value.bounty.bountyId;
  const balancesOf = async actor => (await mcpCall(store, keys, actor, "bounty_read_balances", {})).value.balances;
  const preFund = await balancesOf("agent");
  await mcpCall(store, keys, "agent", "bounty_fund", { bountyId, idempotencyKey: "mcp-fund-1" });
  assert.equal((await balancesOf("agent")).locked, 5);
  const unfunded = await mcpCall(store, keys, "agent", "bounty_unfund", { bountyId, idempotencyKey: "mcp-unfund-1" });
  assert.equal(unfunded.isError, false);
  assert.equal(unfunded.value.bounty.state, "refunded");
  assert.equal(unfunded.value.settlement.kind, "poster-withdrawn");
  assert.equal(unfunded.value.settlement.refundMillis, 5000);
  assert.deepEqual(await balancesOf("agent"), preFund); // byte-identical to pre-fund, via the MCP read itself
  assert.equal(escrow.verifyConservation("commons").ok, true);

  const draft = await mcpCall(store, keys, "agent", "bounty_post", {
    title: "Draft", criteria: "C", amount: 5, deadline: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: "mcp-post-2" });
  const deleted = await mcpCall(store, keys, "agent", "bounty_delete", { bountyId: draft.value.bounty.bountyId, idempotencyKey: "mcp-del-1" });
  assert.equal(deleted.value.bounty.state, "cancelled");

  const third = await mcpCall(store, keys, "agent", "bounty_post", {
    title: "T3", criteria: "C", amount: 5, deadline: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: "mcp-post-3" });
  const thirdId = third.value.bounty.bountyId;
  await mcpCall(store, keys, "agent", "bounty_fund", { bountyId: thirdId, idempotencyKey: "mcp-fund-3" });
  await mcpCall(store, keys, "worker", "bounty_claim", { bountyId: thirdId, idempotencyKey: "mcp-claim-3" });
  await assert.rejects(
    () => mcpCall(store, keys, "agent", "bounty_unfund", { bountyId: thirdId, idempotencyKey: "mcp-unfund-3" }),
    error => /claimed: 5 credits stay locked/.test(error.message));
  assert.equal(escrow.verifyConservation("commons").ok, true);
});
