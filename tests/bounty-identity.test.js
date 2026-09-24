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

const ROOM = "room-identity";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const CODEX = "id:agent/codex";
const OWNER = "owner";
const GHOST = "id:agent/ghost"; // never a member

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
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

test("transfers to non-members are rejected; members and the pool are allowed", () => {
  const { escrow } = makeEscrow();
  expectCode(() => escrow.transfer(ROOM, { from: JILL, to: GHOST, amount: 1 }), "not_authorized");
  const toPool = escrow.transfer(ROOM, { from: JILL, to: "pool", amount: 1 });
  assert.equal(toPool.to, "pool");
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
