// tests/bounty-escrow-pins.test.js — B1-3 PIN tests for the settlement /
// fee / payout regions of server/bounty-escrow.mjs (R1 L2188–2312, R2
// L2568–3004). Landed from the methods audit (wave-2026-10-26-methods-audit,
// phase-b/B1, B1-3): the audit's distinguishing tests for the 33 ACTIONABLE
// survivor groups S-1…S-33, unweakened. The 4 UNRESOLVED survivors (mutants
// 21, 134, 271, 283 — _ensure deletes in rejectWork/closeEpoch, the
// rubricCheck spread negation, and closeEpoch's isolated-transaction flag)
// are deliberately NOT pinned here: their proving steps need store doubles
// the repo does not have, and pins are not filed on suspicion.
// B1-3 distinguishing tests for bounty-escrow.mjs R1/R2 survivors
// (M-A ACTIONABLE triage). Each test passes on the unmutated module and is
// designed to fail on one or more named surviving mutants from the B1-3
// escrow run. Scaffold mirrors tests/bounty-escrow.test.js (in-memory
// store double) — the oracle these supplement.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, TRACK_ACCEPTANCE } from "../server/bounty-escrow.mjs";
import { createReceiptSigner } from "../server/bounty-receipts.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const CODEX = "id:agent/codex";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const isoNow = () => new Date(nowMs).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  // A receipt signer is configured so movements carry signed receipts —
  // the signed-receipt surfaces (receipt.signed, summary.signedReceipts)
  // are observable only then (unsigned production default returns []).
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true,
    receipts: createReceiptSigner({ seedHex: "ab".repeat(32), ref: "b1-3-test" }) });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}
const bal = (escrow, lane) => escrow.balances(ROOM, lane);
const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };
const codeOf = fn => errOf(fn)?.code ?? null;
const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: isoNow(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] });
function runToSubmitted(escrow, { amount = 10, verifier = null, approvalMode = "human" } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier, approvalMode });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  return escrow.getBounty(ROOM, bounty.bountyId);
}
function runToAccepted(escrow, { amount = 10, verifier = null } = {}) {
  const bounty = runToSubmitted(escrow, { amount, verifier });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
  return escrow.getBounty(ROOM, bounty.bountyId);
}
function runToDisputed(escrow, { amount = 10 } = {}) {
  const bounty = runToAccepted(escrow, { amount, verifier: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: amount / 4, grounds: "bad work" });
  return { bounty: escrow.getBounty(ROOM, bounty.bountyId), dispute };
}
const failNthMove = (escrow, bountyId, n) => {
  const original = escrow._move.bind(escrow);
  let seen = 0;
  escrow._move = args => {
    if (args.bountyId === bountyId && ++seen === n) throw new Error("injected mid-settlement failure");
    return original(args);
  };
  return () => { escrow._move = original; };
};
const eventsOf = (escrow, bountyId, type) =>
  escrow.listEvents(ROOM).filter(e => e.bountyId === bountyId && e.type === type);

test("E1 _recordSettlement validates its inputs directly (MUT 1,2,3,5,6,8,9,10,12,15,20)", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToSubmitted(escrow, {});
  const b = escrow._mutable(db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(bounty.bountyId));
  const good = { kind: "failed", workerMillis: 0, refundMillis: 10000, reason: "nope", actor: null };
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, kind: "bogus" })), "invalid_input");
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, workerMillis: -1 })), "invalid_amount");
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, workerMillis: 1.5 })), "invalid_amount");
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, refundMillis: -1 })), "invalid_amount");
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, refundMillis: 2.5 })), "invalid_amount");
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, reason: "" })), "invalid_input");
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, reason: "x".repeat(501) })), "invalid_input");
  assert.equal(codeOf(() => escrow._recordSettlement(b, { ...good, reason: undefined })), "invalid_input");
  const first = escrow._recordSettlement(b, { ...good, reason: "x" }); // 1-char reason is legal
  assert.equal(first.alreadySettled, false);
  const second = escrow._recordSettlement(b, good);
  assert.equal(second.alreadySettled, true);
  assert.equal(second.settlement.reason, "x"); // stored verdict replays, not overwritten
});

test("E2 rejectWork refusal message names the mode's approver (MUT 26,27,28,29)", () => {
  const { escrow, db } = makeEscrow();
  const human = runToSubmitted(escrow, {});
  const e1 = errOf(() => escrow.rejectWork(ROOM, human.bountyId, { rejector: CODEX, reason: "bad" }));
  assert.equal(e1.code, "not_authorized");
  assert.match(e1.message, /only the poster may reject a human-approved bounty/);
  const agent = runToSubmitted(escrow, { verifier: INSTINCT, approvalMode: "agent" });
  const e2 = errOf(() => escrow.rejectWork(ROOM, agent.bountyId, { rejector: CODEX, reason: "bad" }));
  assert.equal(e2.code, "not_authorized");
  assert.match(e2.message, /only the designated agent verifier may reject an agent-approved bounty/);
  // "legacy" is not postable at this SHA (postBounty admits human/agent);
  // it is the stored mode of pre-mode rows — set it directly on the row.
  const legacy = runToSubmitted(escrow, {});
  db.prepare("UPDATE bounty_records SET approval_mode='legacy' WHERE bounty_id=?").run(legacy.bountyId);
  const e3 = errOf(() => escrow.rejectWork(ROOM, legacy.bountyId, { rejector: CODEX, reason: "bad" }));
  assert.equal(e3.code, "not_authorized");
  assert.match(e3.message, /only the poster or designated verifier may reject a legacy bounty/);
});

test("E3 the claimant cannot reject their own work even as designated verifier (MUT 30)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { verifier: GROK, approvalMode: "agent" });
  assert.equal(codeOf(() => escrow.rejectWork(ROOM, bounty.bountyId, { rejector: GROK, reason: "bad" })), "not_authorized");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
});

test("E4 rejectWork replay reports alreadySettled (MUT 34)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, {});
  const first = escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason: "bad" });
  assert.equal(first.alreadySettled, false);
  const replay = escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason: "bad" });
  assert.equal(replay.alreadySettled, true);
  assert.equal(replay.receipt.replayed, true);
});

test("E5 rejectWork reason edges: 1 char legal, missing reason is invalid_input (MUT 38,39,41)", () => {
  const { escrow } = makeEscrow();
  const b1 = runToSubmitted(escrow, {});
  const ok = escrow.rejectWork(ROOM, b1.bountyId, { rejector: JILL, reason: "x" });
  assert.equal(ok.settlement.reason, "x");
  const b2 = runToSubmitted(escrow, {});
  assert.equal(codeOf(() => escrow.rejectWork(ROOM, b2.bountyId, { rejector: JILL })), "invalid_input");
  assert.equal(escrow.getBounty(ROOM, b2.bountyId).state, "submitted");
});

test("E6 first-touch finalize self-ensures; closeEpoch mints genesis for a new room (MUT 263,272)", () => {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT t");
    try { const out = fn(); db.exec("RELEASE t"); return out; }
    catch (e) { db.exec("ROLLBACK TO t"); db.exec("RELEASE t"); throw e; }
  };
  const escrow = new BountyEscrow({ db, transaction, readTransaction: transaction },
    { now: () => nowMs, allowLegacyStringLanes: true });
  // finalizeBounty as the literal first call: _ensure builds the schema,
  // so the answer is the domain error, not a missing-table crash.
  assert.equal(codeOf(() => escrow.finalizeBounty(ROOM, "nope", {})), "unknown_bounty");
  // closeEpoch on a virgin instance, for a room genesis never touched,
  // mints that room's genesis itself. (Separate instance: schema setup
  // order is part of what is being probed.)
  const db2 = new DatabaseSync(":memory:");
  const tx2 = fn => {
    db2.exec("SAVEPOINT t");
    try { const out = fn(); db2.exec("RELEASE t"); return out; }
    catch (e) { db2.exec("ROLLBACK TO t"); db2.exec("RELEASE t"); throw e; }
  };
  const escrow2 = new BountyEscrow({ db: db2, transaction: tx2, readTransaction: tx2 },
    { now: () => nowMs, allowLegacyStringLanes: true });
  const epoch = escrow2.closeEpoch("room-2", {});
  assert.deepEqual(epoch.summary.swept, []);
  assert.equal(escrow2.balances("room-2", JILL).payable, 100);
});

test("E7 unverified keeper settlement: resolution kind, refunded event, signed receipt (MUT 55,57,59)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, {});
  tick(3_600_000 + 1);
  const epoch = escrow.closeEpoch(ROOM, {});
  assert.deepEqual(epoch.summary.refunded, [bounty.bountyId]);
  assert.equal(epoch.summary.signedReceipts[bounty.bountyId].length, 1);
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.state, "refunded");
  assert.equal(settled.resolution.kind, "unverified");
  assert.equal(eventsOf(escrow, bounty.bountyId, "bounty.refunded").length, 1);
});

test("E8 _onDisputeFinalized guards: wrong track throws, unknown bounty is a no-op (MUT 60,63)", () => {
  const { escrow } = makeEscrow();
  assert.equal(codeOf(() => escrow._onDisputeFinalized(
    { track: "economic", bountyId: "nope", outcome: "rejected", terminal: "decided" })), "internal");
  const out = escrow._onDisputeFinalized(
    { track: TRACK_ACCEPTANCE, bountyId: "nope", outcome: "rejected", terminal: "decided" });
  assert.equal(out, undefined);
});

test("E9 dispute settlement events are attributed to the decider, not the rule actor (MUT 67)", () => {
  const { escrow } = makeEscrow();
  const { bounty } = runToDisputed(escrow, {});
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  const decided = eventsOf(escrow, bounty.bountyId, "bounty.decided");
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0].actor, { kind: "agent", id: INSTINCT });
});

test("E10 frivolous ruling forfeits the challenger bond to the pool (MUT 78,79,127)", () => {
  const { escrow } = makeEscrow();
  const { bounty } = runToDisputed(escrow, { amount: 10 });
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "frivolous", reasonCodes: ["frivolous"] });
  assert.equal(settled.resolution.bondForfeited, true);
  assert.equal(bal(escrow, "pool").payable, 2.5); // bond to the pool, not compensation
  escrow.closeEpoch(ROOM, {});
  assert.equal(bal(escrow, GROK).payable, 99 + 9.9 + 1); // award + claim bond back, no +2.5
  assert.equal(bal(escrow, CODEX).locked, 0);
});

test("E11 upheld dispute: signed receipts, claimant flake, failed settlement record (MUT 80,81,95,96,149,150)", () => {
  const { escrow } = makeEscrow();
  const { bounty } = runToDisputed(escrow, { amount: 10 });
  const { bounty: settled, receipt } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.ok(receipt.signed.length >= 1, "cancel settlement collects the refund receipt");
  assert.equal(bal(escrow, GROK).flake.strikes, 1);
  assert.equal(settled.resolution.settlement.kind, "failed");
  assert.equal(settled.resolution.settlement.workerMillis, 0);
  assert.equal(settled.resolution.settlement.refundMillis, 10000);
  assert.match(settled.resolution.settlement.reason, /work judged bad/);
  const evts = eventsOf(escrow, bounty.bountyId, "bounty.refunded");
  assert.equal(evts.length, 1);
  assert.equal(eventsOf(escrow, bounty.bountyId, "bounty.released").length, 0);
});

test("E12 release/split settlement records and the bounty.decided payload (MUT 151,152,156,158,160,161,162)", () => {
  const { escrow } = makeEscrow();
  const rel = runToDisputed(escrow, { amount: 10 });
  const { bounty: relSettled } = escrow.decideDispute(ROOM, rel.bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(relSettled.resolution.settlement.kind, "verified-complete");
  assert.equal(relSettled.resolution.settlement.workerMillis, 10000);
  assert.equal(relSettled.resolution.settlement.refundMillis, 0);
  assert.match(relSettled.resolution.settlement.reason, /award vests with the worker/);
  const decided = eventsOf(escrow, rel.bounty.bountyId, "bounty.decided");
  assert.equal(decided.length, 1);
  assert.equal(decided[0].data.outcome, "rejected");
  assert.equal(decided[0].data.challenger, CODEX);
  assert.equal(decided[0].data.verifier, JILL);
  const spl = runToDisputed(escrow, { amount: 10 });
  const { bounty: splSettled } = escrow.decideDispute(ROOM, spl.bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(splSettled.resolution.settlement.kind, "partial");
  assert.equal(splSettled.resolution.settlement.workerMillis, 5000);
  assert.equal(splSettled.resolution.settlement.refundMillis, 5000);
  assert.match(splSettled.resolution.settlement.reason, /half the award vests/);
});

test("E13 timeout-default: the challenger bond goes to the pool, never the worker (MUT 127,129)", () => {
  const { escrow } = makeEscrow();
  const { bounty } = runToDisputed(escrow, { amount: 10 });
  tick(14 * 24 * 3_600_000 + 1);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(action, "released");
  assert.equal(bal(escrow, "pool").payable, 2.5);
  assert.equal(bal(escrow, CODEX).locked, 0);
  assert.equal(bal(escrow, GROK).payable, 99); // no bond compensation on a no-verdict default
  // The timeout default is a settlement with a verdict string, so it DOES
  // emit bounty.decided (the keeper path has no decideDispute fallback).
  const decided = eventsOf(escrow, bounty.bountyId, "bounty.decided");
  assert.equal(decided.length, 1);
  assert.equal(decided[0].data.outcome, "timeout-default");
  assert.equal(decided[0].data.challenger, CODEX);
});

test("E14 _settleClaimBond: repeat settle is a no-op; journal kind and memo name the forfeit (MUT 167,170,171)", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow, { amount: 8 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(3_600_000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {}); // timeout: bond forfeited
  const rows = db.prepare("SELECT kind, memo FROM bounty_journal WHERE bounty_id=? AND kind LIKE 'bond-%'").all(bounty.bountyId);
  assert.ok(rows.some(r => r.kind === "bond-forfeit"));
  assert.ok(rows.some(r => r.memo === "claim bond forfeited to pool (anti-flake ladder)"));
  const b = escrow._mutable(db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(bounty.bountyId));
  const out = escrow._settleClaimBond(b, isoNow(), { forfeit: true, actor: null }); // nothing left locked
  assert.equal(out, undefined);
});

test("E15 timeout refund observables (MUT 177,178,179,182,183,184,185,186,187)", () => {
  const { escrow } = makeEscrow();
  const claimed = post(escrow, { amount: 8 });
  escrow.fundBounty(ROOM, claimed.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, claimed.bountyId, { claimant: GROK });
  tick(3_600_000 + 1);
  const fin = escrow.finalizeBounty(ROOM, claimed.bountyId, {});
  assert.equal(fin.action, "refunded");
  assert.equal(fin.receipt.signed.length, 1);
  const settled = escrow.getBounty(ROOM, claimed.bountyId);
  assert.equal(settled.resolution.kind, "timeout");
  assert.equal(settled.resolution.flake.rung, 1);
  assert.match(settled.resolution.settlement.reason, /flake rung 1/);
  const evts = eventsOf(escrow, claimed.bountyId, "bounty.refunded");
  assert.equal(evts.length, 1);
  assert.equal(evts[0].data.flake.rung, 1);
  const unclaimed = post(escrow, { amount: 8 });
  escrow.fundBounty(ROOM, unclaimed.bountyId, { funder: JILL });
  tick(3_600_000 + 1);
  escrow.finalizeBounty(ROOM, unclaimed.bountyId, {});
  const settled2 = escrow.getBounty(ROOM, unclaimed.bountyId);
  assert.equal(settled2.resolution.kind, "timeout");
  assert.equal(settled2.resolution.flake, null);
  assert.match(settled2.resolution.settlement.reason, /work never completed/);
});

test("E16 expired-unfunded: label and declined event (MUT 190,192,193)", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, {});
  tick(3_600_000 + 1);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(action, "expired-unfunded");
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "cancelled");
  assert.equal(after.label, "Expired");
  const evts = eventsOf(escrow, bounty.bountyId, "bounty.declined");
  assert.equal(evts.length, 1);
  assert.equal(evts[0].data.automatic, true);
});

test("E17 auto-approve resolution and event; sweep emits bounty.paid (MUT 197,199,216)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10 });
  tick(3 * 24 * 3_600_000 + 1);
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(fin.action, "approved");
  const approved = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(approved.resolution.kind, "auto-approve");
  assert.equal(eventsOf(escrow, bounty.bountyId, "bounty.approved").length, 1);
  escrow.closeEpoch(ROOM, {});
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  assert.equal(eventsOf(escrow, bounty.bountyId, "bounty.paid").length, 1);
});

test("E18 keeper acts AT the deadline/window boundary, not only past it (MUT 222,232,237,243)", () => {
  { // proposed expiry at exactly deadlineMs
    const { escrow } = makeEscrow();
    const bounty = post(escrow, {});
    tick(3_600_000);
    assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "expired-unfunded");
  }
  { // claimed timeout at exactly deadlineMs
    const { escrow } = makeEscrow();
    const bounty = post(escrow, { amount: 8 });
    escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
    escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
    tick(3_600_000);
    assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "refunded");
  }
  { // submitted free-miss at exactly deadlineMs
    const { escrow } = makeEscrow();
    const bounty = runToSubmitted(escrow, {});
    tick(3_600_000);
    assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "refunded");
  }
  { // challenge-window approval at exactly challengeEndsMs (3d for a 10-credit bounty)
    const { escrow } = makeEscrow();
    const bounty = runToAccepted(escrow, { amount: 10 });
    tick(3 * 24 * 3_600_000);
    assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "approved");
  }
});

test("E19 a snoozed proposal expires when the snooze ends past its deadline (MUT 223,225)", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, {});
  escrow.snoozeBounty(ROOM, bounty.bountyId, { snoozer: JILL, until: isoFuture(7_200_000) });
  tick(7_200_000); // exactly the snooze end, past the 1h deadline
  assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "expired-unfunded");
});

test("E20 dispute timeout guard: no early default, strictly past 14 days (MUT 258,260,261)", () => {
  const { escrow, db } = makeEscrow();
  const { bounty, dispute } = runToDisputed(escrow, { amount: 10 });
  // immediately: nothing to finalize
  assert.equal(codeOf(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {})), "invalid_state");
  // exactly 14 days: still not past the timeout (strict >)
  tick(14 * 24 * 3_600_000);
  assert.equal(codeOf(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {})), "invalid_state");
  // a legacy row with no dispute_opened_ms never times out
  db.prepare("UPDATE bounty_records SET dispute_opened_ms=NULL WHERE bounty_id=?").run(bounty.bountyId);
  tick(1);
  assert.equal(codeOf(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {})), "invalid_state");
  // restore the timestamp: now past 14d, the default fires
  db.prepare("UPDATE bounty_records SET dispute_opened_ms=? WHERE bounty_id=?").run(nowMs - 14 * 24 * 3_600_000 - 1, bounty.bountyId);
  assert.equal(escrow.finalizeBounty(ROOM, bounty.bountyId, {}).action, "released");
  assert.ok(dispute.disputeId);
});

test("E21 finalizeBounty on an unknown bounty (MUT 268)", () => {
  const { escrow } = makeEscrow();
  assert.equal(codeOf(() => escrow.finalizeBounty(ROOM, "nope", {})), "unknown_bounty");
});

test("E22 closeEpoch summary bookkeeping per action (MUT 280,281,282,283,287,288,289,290,291,292,293,294,295,299,300,301,302,303,304)", () => {
  const { escrow } = makeEscrow();
  const toApprove = runToAccepted(escrow, { amount: 10 });
  const toRefund = runToSubmitted(escrow, {});
  const toExpire = post(escrow, {});
  const toSweep = runToAccepted(escrow, { amount: 10 });
  assert.equal(codeOf(() => escrow.finalizeBounty(ROOM, toSweep.bountyId, {})), "invalid_state"); // window still open
  tick(3 * 24 * 3_600_000 + 1);
  // approve toSweep manually now that its window has passed, so the epoch sweeps it
  escrow.finalizeBounty(ROOM, toSweep.bountyId, {});
  const epoch = escrow.closeEpoch(ROOM, {});
  assert.deepEqual(epoch.summary.approved, [toApprove.bountyId]);
  assert.deepEqual(epoch.summary.refunded, [toRefund.bountyId]);
  assert.deepEqual(epoch.summary.expiredUnfunded, [toExpire.bountyId]);
  assert.deepEqual(epoch.summary.swept, [toSweep.bountyId]);
  assert.deepEqual(epoch.summary.paid, [{ bountyId: toSweep.bountyId, paid: 9.9, fee: 0.1 }]);
  assert.equal(epoch.summary.signedReceipts[toRefund.bountyId].length, 1);
  assert.equal(epoch.summary.signedReceipts[toSweep.bountyId].length, 1);
});

test("E23 closeEpoch records a released dispute-timeout in the summary (MUT 296,297,298)", () => {
  const { escrow } = makeEscrow();
  const { bounty } = runToDisputed(escrow, { amount: 10 });
  tick(14 * 24 * 3_600_000 + 1);
  const epoch = escrow.closeEpoch(ROOM, {});
  assert.deepEqual(epoch.summary.released, [bounty.bountyId]);
});

test("E24 closeEpoch failure entry carries the fallback code (MUT 310)", () => {
  const { escrow } = makeEscrow();
  const a = runToAccepted(escrow, { amount: 10 });
  tick(3 * 24 * 3_600_000 + 1);
  escrow.finalizeBounty(ROOM, a.bountyId, {});
  const restore = failNthMove(escrow, a.bountyId, 2); // fee move throws (plain Error, no .code)
  const epoch = escrow.closeEpoch(ROOM, {});
  restore();
  assert.equal(epoch.summary.failed.length, 1);
  assert.equal(epoch.summary.failed[0].bountyId, a.bountyId);
  assert.equal(epoch.summary.failed[0].code, "error");
});

test("E25 keeper retry: a resolved-but-unsettled dispute settles on finalize (MUT 249,253,255,256)", () => {
  const { escrow } = makeEscrow();
  const { bounty, dispute } = runToDisputed(escrow, { amount: 10 });
  const machine = escrow._disputes;
  machine.decide(dispute.disputeId, { outcome: "rejected", reasonCodes: ["evidence-insufficient"], decider: INSTINCT });
  const restore = failNthMove(escrow, bounty.bountyId, 1);
  try { machine.finalize(dispute.disputeId); } catch { /* handler threw mid-settlement */ }
  restore();
  // Machine record is resolved; the bounty is still disputed and unsettled.
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "resolved");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(fin.action, "released");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.resolution.outcome, "rejected");
  assert.equal(settled.resolution.kind, "release");
});

test("E26 legacy from-submitted dispute settles through the attribute arm (MUT 103,104,106,116,117,119)", () => {
  const craftFromSubmitted = (escrow, db) => {
    const bounty = runToSubmitted(escrow, { amount: 10, verifier: INSTINCT });
    const disputeId = "dsp_legacy_from_submitted";
    const bondMillis = 2500;
    escrow._move({ roomId: ROOM, at: isoNow(),
      from: { account: CODEX, state: "payable" }, to: { account: CODEX, state: "locked" },
      amountMillis: bondMillis, kind: "bond-lock", bountyId: bounty.bountyId, lotId: "lot_legacy_sub",
      memo: `dispute bond for ${disputeId}`, actor: null });
    const machine = escrow._disputes;
    let d = machine.open({ disputeId, bountyId: bounty.bountyId, bountyAmount: 10000, raisedBy: CODEX, reason: "bad", kind: "economic", bond: bondMillis });
    escrow._persistDispute(ROOM, d);
    d = machine.challenge(disputeId, { by: CODEX }); escrow._persistDispute(ROOM, d);
    d = machine.submitEvidence(disputeId, { by: CODEX, summary: "bad" }); escrow._persistDispute(ROOM, d);
    d = machine.seatDecider(disputeId, { decider: INSTINCT }); escrow._persistDispute(ROOM, d);
    db.prepare("UPDATE bounty_records SET state='disputed', dispute_id=?, dispute_opened_ms=? WHERE bounty_id=?")
      .run(disputeId, nowMs, bounty.bountyId);
    return bounty;
  };
  { // SPLIT from submitted: attribute the full award, vest half, refund half
    const { escrow, db } = makeEscrow();
    const bounty = craftFromSubmitted(escrow, db);
    const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
      { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
    assert.equal(settled.resolution.kind, "split");
    assert.equal(bal(escrow, GROK).approved, 5);
    assert.equal(bal(escrow, JILL).payable, 95);
    assert.equal(bal(escrow, GROK).attributed, 0);
    assert.equal(escrow.verifyConservation(ROOM).ok, true);
  }
  { // RELEASE from submitted: attribute then vest the whole award
    const { escrow, db } = makeEscrow();
    const bounty = craftFromSubmitted(escrow, db);
    const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
      { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
    assert.equal(settled.resolution.kind, "release");
    assert.equal(bal(escrow, GROK).approved, 10);
    assert.equal(bal(escrow, GROK).attributed, 0);
    assert.equal(escrow.verifyConservation(ROOM).ok, true);
  }
});

test("E30 outcome-less keeper settlement: a withdrawn dispute settles with no bounty.decided (MUT 157)", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  // A withdrawn challenge is a legacy record shape at this SHA (the
  // machine's withdraw rung is gone) — inject the record the keeper
  // would hydrate, with the challenger's bond actually locked.
  const disputeId = "dsp_withdrawn_legacy";
  escrow._move({ roomId: ROOM, at: isoNow(),
    from: { account: CODEX, state: "payable" }, to: { account: CODEX, state: "locked" },
    amountMillis: 2500, kind: "bond-lock", bountyId: bounty.bountyId, lotId: "lot_withdrawn",
    memo: `dispute bond for ${disputeId}`, actor: null });
  const record = { disputeId, bountyId: bounty.bountyId, bountyAmount: 10000, state: "withdrawn",
    raisedBy: CODEX, reason: "bad", kind: "economic", bond: 2500, bondSnapshot: 2500,
    forfeitedBond: 2500, decider: INSTINCT, resolution: null };
  escrow._disputeRecords.set(disputeId, Object.freeze(record));
  escrow._persistDispute(ROOM, record);
  db.prepare("UPDATE bounty_records SET state='disputed', dispute_id=?, dispute_opened_ms=? WHERE bounty_id=?")
    .run(disputeId, nowMs, bounty.bountyId);
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(fin.action, "released");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.state, "approved");
  assert.equal(eventsOf(escrow, bounty.bountyId, "bounty.decided").length, 0); // no verdict, no decision event
  assert.equal(bal(escrow, "pool").payable, 2.5); // withdrawn challenge forfeits the bond to the pool
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("E27 the dispute-settling flag is cleared after settlement (MUT 131)", () => {
  const { escrow } = makeEscrow();
  const { bounty } = runToDisputed(escrow, { amount: 10 });
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(escrow._disputeSettling, null);
});

test("E28 finality/acceptance guards refuse direct calls in the wrong state (MUT 51,172,194,205)", () => {
  const { escrow, db } = makeEscrow();
  const accepted = runToAccepted(escrow, { amount: 10 });
  const bAccepted = escrow._mutable(db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(accepted.bountyId));
  assert.equal(codeOf(() => escrow._timeoutRefund(bAccepted, isoNow(), null)), "missing_verdict");
  assert.equal(codeOf(() => escrow._settleUnverified(bAccepted, isoNow(), null)), "missing_verdict");
  const actor = { kind: "rule", id: "escrow-keeper" };
  // _sweep's payout guard fires only when approved millis exist: vest a
  // bounty, then roll its state back to accepted underneath the lot.
  const vest = runToAccepted(escrow, { amount: 10 });
  tick(3 * 24 * 3_600_000 + 1);
  escrow.finalizeBounty(ROOM, vest.bountyId, {}); // -> approved, lot vested
  db.prepare("UPDATE bounty_records SET state='accepted' WHERE bounty_id=?").run(vest.bountyId);
  const bVest = escrow._mutable(db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(vest.bountyId));
  assert.equal(codeOf(() => escrow._sweep(bVest, isoNow(), actor)), "missing_verdict");
  const submitted = runToSubmitted(escrow, {});
  const bSubmitted = escrow._mutable(db.prepare("SELECT * FROM bounty_records WHERE bounty_id=?").get(submitted.bountyId));
  assert.equal(codeOf(() => escrow._approve(bSubmitted, isoNow(), null)), "missing_verdict");
  // nothing moved: the accepted bounty's award is still attributed, not refunded or paid
  assert.equal(bal(escrow, GROK).attributed, 10);
  assert.equal(bal(escrow, GROK).payable, 97); // three claim bonds locked, nothing released
});

test("E29 a disputed bounty with no dispute id has nothing to finalize (MUT 246)", () => {
  const { escrow, db } = makeEscrow();
  const { bounty } = runToDisputed(escrow, { amount: 10 });
  db.prepare("UPDATE bounty_records SET dispute_id=NULL WHERE bounty_id=?").run(bounty.bountyId);
  assert.equal(codeOf(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {})), "invalid_state");
});
