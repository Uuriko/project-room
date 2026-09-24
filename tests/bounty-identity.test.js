// Regression tests for the bounty-ledger identity/attribution repair
// (RC-2026-09-24-315).
//
// Invariant under test: a lane id is only meaningful when it names a CURRENT,
// active member of the room. The escrow binds every acting lane, every
// designated verifier, every transfer recipient, and every journal actor to
// the room's live membership (store.roomAuthority). Stale, phantom, or
// explicitly-supplied mismatched identities fail closed.
//
// The store double here exposes roomAuthority(), so these tests exercise the
// strict membership path (production behavior). Pure unit-test doubles
// without roomAuthority keep the legacy string-only behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { projectBountyReputation } from "../server/bounty-reputation.mjs";

const ROOM = "room-identity";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const CODEX = "id:agent/codex";
const OWNER = "owner";
const GHOST = "id:agent/ghost"; // never a member

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeMembers() {
  return {
    [JILL]: { active: true, kind: "agent", displayName: "jill" },
    [GROK]: { active: true, kind: "agent", displayName: "grokbot" },
    [INSTINCT]: { active: true, kind: "agent", displayName: "instinct" },
    [CODEX]: { active: true, kind: "agent", displayName: "codex" },
    [OWNER]: { active: true, kind: "human", displayName: "owner" },
  };
}

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT identity_test");
    try { const out = fn(); db.exec("RELEASE identity_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO identity_test"); db.exec("RELEASE identity_test"); throw error; }
  };
  const members = makeMembers();
  const store = {
    db,
    transaction,
    readTransaction: transaction,
    now: () => nowMs,
    roomAuthority: roomId => {
      assert.equal(roomId, ROOM);
      return { sequence: 1, ownerId: OWNER, members };
    },
  };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, members };
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;

const ATTEST = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

function runToDisputed(escrow, { verifierId = INSTINCT } = {}) {
  const bounty = post(escrow, { verifierId });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
  const disputed = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "looks off" });
  return disputed.bounty;
}

test("a lane that is not a room member cannot post a bounty", () => {
  const { escrow } = makeEscrow();
  expectCode(() => post(escrow, { poster: GHOST }), "not_authorized");
});

test("an inactive member cannot act on the ledger", () => {
  const { escrow, members } = makeEscrow();
  members[GROK].active = false;
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }), "not_authorized");
});

test("a removed member cannot act again", () => {
  const { escrow, members } = makeEscrow();
  const bounty = post(escrow, { poster: GROK });
  delete members[GROK];
  expectCode(() => escrow.fundBounty(ROOM, bounty.bountyId, { funder: GROK }), "not_authorized");
});

test("the designated verifier must be a current agent member, not a phantom lane", () => {
  const { escrow } = makeEscrow();
  // A hardcoded-looking lane that was never a member is rejected.
  expectCode(() => post(escrow, { verifierId: GHOST }), "not_authorized");
  // A human member is not an eligible verifier.
  expectCode(() => post(escrow, { verifierId: OWNER }), "invalid_input");
  // A current agent member is accepted.
  const bounty = post(escrow, { verifierId: INSTINCT });
  assert.equal(bounty.verifier, INSTINCT);
});

test("the verifier cannot be the poster", () => {
  const { escrow } = makeEscrow();
  expectCode(() => post(escrow, { verifierId: JILL }), "invalid_input");
});

test("transfers to non-members are rejected; the pool is escrow-internal", () => {
  const { escrow } = makeEscrow();
  expectCode(() => escrow.transfer(ROOM, { from: JILL, to: GHOST, amount: 1 }), "not_authorized");
  // The pool is the escrow's internal fee sink, not a participant: public
  // transfers cannot target it. Internal settlement paths (fee sweep, bond
  // forfeit) still move value to the pool — covered by the fee and forfeit
  // tests in bounty-escrow.test.js.
  expectCode(() => escrow.transfer(ROOM, { from: JILL, to: "pool", amount: 1 }), "not_authorized");
  const toMember = escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 1 });
  assert.equal(toMember.to, GROK);
  assert.equal(toMember.from, JILL);
});

test("an explicitly supplied actor that names a different lane is rejected", () => {
  const { escrow } = makeEscrow();
  // Claiming to act as grokbot while authenticated as jill fails closed.
  expectCode(() => escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C",
    amount: 10, deadline: isoFuture(3_600_000), actor: { kind: "agent", id: GROK } }), "not_authorized");
  // A matching explicit actor is honored and the journal binds to the validated lane.
  const { receipt } = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C",
    amount: 10, deadline: isoFuture(3_600_000), actor: { kind: "agent", id: JILL } });
  assert.equal(receipt.actor.id, JILL);
  assert.equal(receipt.actor.kind, "agent");
});

test("journal actors are derived from the validated lane, never the raw input", () => {
  const { escrow } = makeEscrow();
  const { receipt } = escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 2 });
  assert.equal(receipt.actor.id, JILL);
  assert.equal(receipt.actor.kind, "agent");
});

test("a seated verifier who leaves the room cannot rule on the dispute", () => {
  const { escrow, members } = makeEscrow();
  const bounty = runToDisputed(escrow);
  assert.equal(bounty.state, "disputed");
  delete members[INSTINCT]; // verifier leaves mid-dispute
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["evidence-insufficient"] }), "not_authorized");
});

test("only the seated decider may rule — a current member cannot substitute", () => {
  const { escrow } = makeEscrow();
  const bounty = runToDisputed(escrow);
  // CODEX is a current member but was not seated as the decider.
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: CODEX, outcome: "upheld", reasonCodes: ["evidence-insufficient"] }), "not_authorized");
});

test("the seated verifier can still rule while a member, and settlement moves only through escrow", () => {
  const { escrow } = makeEscrow();
  const bounty = runToDisputed(escrow);
  const { receipt } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(receipt.actor.id, INSTINCT);
  // The ruling settled the bounty through the escrow's own settlement path:
  // the bounty left the disputed state and the ledger still conserves.
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.notEqual(settled.state, "disputed");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("arbitrator cards are drawn from current membership, not a hardcoded list", () => {
  const { escrow, members } = makeEscrow();
  const cards = escrow._laneCards(ROOM).map(c => c.lane).sort();
  assert.deepEqual(cards, [CODEX, GROK, INSTINCT, JILL].sort());
  delete members[INSTINCT];
  const after = escrow._laneCards(ROOM).map(c => c.lane).sort();
  assert.deepEqual(after, [CODEX, GROK, JILL].sort());
});

test("a dispute with no eligible seated verifier is honestly unavailable", () => {
  const { escrow, members } = makeEscrow();
  const bounty = post(escrow); // no verifier designated
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
  // Fund the challenger's bond before removing the agent members.
  escrow.transfer(ROOM, { from: JILL, to: OWNER, amount: 10 });
  // Remove every agent member: arbitration has nobody to seat. The dispute is
  // still recorded, but marked honestly unavailable — no phantom decider.
  for (const id of [JILL, GROK, INSTINCT, CODEX]) delete members[id];
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: OWNER, bond: 2.5, grounds: "x" });
  assert.equal(dispute.decider, null);
  assert.match(dispute.unavailable ?? "", /no-designated-verifier/);
});

test("journal actor kind derives from the membership record, not the lane string", () => {
  const { escrow, members } = makeEscrow();
  // Production agent identities are opaque ids (ai_...), not id:agent/...
  // labels: the old prefix rule mislabeled them as human.
  const AI = "ai_Q7xTestAgent001";
  members[AI] = { active: true, kind: "agent", displayName: "test agent" };
  assert.deepEqual(escrow.ensureGenesis(ROOM).lanes, [AI]);
  const agentMove = escrow.transfer(ROOM, { from: AI, to: GROK, amount: 2 });
  assert.equal(agentMove.receipt.actor.id, AI);
  assert.equal(agentMove.receipt.actor.kind, "agent");
  // A human member with a bare id is journaled as human.
  const humanMove = escrow.transfer(ROOM, { from: OWNER, to: GROK, amount: 1 });
  assert.equal(humanMove.receipt.actor.id, OWNER);
  assert.equal(humanMove.receipt.actor.kind, "human");
});

test("a participant-supplied rule actor is rejected", () => {
  const { escrow } = makeEscrow();
  // Participants must not attribute a transition to the mechanical keeper:
  // the rule actor is never a participant identity on these paths.
  expectCode(() => escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C",
    amount: 10, deadline: isoFuture(3_600_000),
    actor: { kind: "rule", id: "escrow-keeper" } }), "not_authorized");
  expectCode(() => escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 1,
    actor: { kind: "rule", id: "escrow-keeper" } }), "not_authorized");
});

test("genesis provisions current members exactly once, never phantom lanes", () => {
  const { escrow, members } = makeEscrow();
  // A member who joins after the first genesis is provisioned on the next call.
  const AI = "ai_Newcomer002";
  members[AI] = { active: true, kind: "agent", displayName: "newcomer" };
  const first = escrow.ensureGenesis(ROOM);
  assert.equal(first.issued, true);
  assert.deepEqual(first.lanes, [AI]);
  assert.equal(escrow.balances(ROOM, AI).payable, 100);
  // Idempotent per member: no double mint, and a lane that was never a
  // member holds nothing.
  const second = escrow.ensureGenesis(ROOM);
  assert.equal(second.issued, false);
  assert.deepEqual(second.lanes, []);
  assert.equal(escrow.balances(ROOM, AI).payable, 100);
  assert.equal(escrow.balances(ROOM, GHOST).total, 0);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("stale and phantom labels accrue no reputation", () => {
  const { escrow, members } = makeEscrow();
  const bounty = runToDisputed(escrow);
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  // Before the membership change both sides' signals project.
  const before = projectBountyReputation(escrow, ROOM).signals.map(s => s.agent);
  assert.ok(before.includes(GROK), "expected grokbot's dispute_won signal");
  assert.ok(before.includes(CODEX), "expected codex's dispute_lost signal");
  // The claimant leaves the room: their stale labels project to nothing,
  // while the challenger's (still a member) survive.
  delete members[GROK];
  const after = projectBountyReputation(escrow, ROOM).signals;
  assert.ok(after.every(s => s.agent !== GROK), "stale label must not accrue reputation");
  assert.ok(after.some(s => s.agent === CODEX), "current member signals must survive");
  // A phantom label that was never a member projects to nothing even when
  // present in the event stream.
  escrow._event(ROOM, "bounty.paid",
    { actor: { kind: "agent", id: GHOST }, data: { earner: GHOST } });
  const phantom = projectBountyReputation(escrow, ROOM).signals;
  assert.ok(phantom.every(s => s.agent !== GHOST), "phantom label must not accrue reputation");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("dispute settlement moves value only through escrow finalization, bound to the decider", () => {
  const { escrow } = makeEscrow();
  const bounty = runToDisputed(escrow);
  const SETTLEMENT_KINDS = new Set(["attribute", "approve", "bond-compensate", "bond-return", "bond-forfeit", "refund"]);
  const settlementIds = who => new Set(escrow.history(ROOM, who)
    .filter(r => r.bountyId === bounty.bountyId && SETTLEMENT_KINDS.has(r.kind))
    .map(r => r.receiptId));
  // The dispute was opened from "accepted", so the accept-time attribution
  // already exists; the dispute machinery itself settles nothing until the
  // decider rules.
  const before = new Set([...settlementIds(GROK), ...settlementIds(CODEX)]);
  const decided = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(decided.receipt.actor.id, INSTINCT);
  assert.equal(decided.receipt.actor.kind, "agent");
  // Every settlement journal entry created by the ruling is attributed to
  // the membership-bound decider whose ruling caused it — never a
  // participant-supplied identity, never the mechanical actor alone.
  const fresh = [...settlementIds(GROK), ...settlementIds(CODEX)].filter(id => !before.has(id));
  assert.ok(fresh.length >= 2, `expected new settlement movements, got ${fresh.length}`);
  for (const id of fresh) {
    const receipt = [...escrow.history(ROOM, GROK), ...escrow.history(ROOM, CODEX)].find(r => r.receiptId === id);
    assert.equal(receipt.actor.id, INSTINCT, `settlement ${receipt.kind} misattributed`);
    assert.equal(receipt.actor.kind, "agent", `settlement ${receipt.kind} kind mislabeled`);
  }
  // A second ruling on the settled dispute fails and moves no value.
  const journalBefore = escrow.history(ROOM, GROK).length + escrow.history(ROOM, CODEX).length;
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] }), "invalid_state");
  const journalAfter = escrow.history(ROOM, GROK).length + escrow.history(ROOM, CODEX).length;
  assert.equal(journalAfter, journalBefore);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
