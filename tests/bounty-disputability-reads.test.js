// DA3-P3 — the computed `disputability` field on bounty reads (F-S1a-3).
//
// Register claim (row 2): a default bounty is born undisputable in silence —
// verifier/disputeDecider null at create/fund, no signal anywhere that no
// dispute can ever be opened or decided. This file pins that every bounty
// read (the post return, the fund return, getBounty, listBounties — the one
// _viewBounty shape behind the HTTP create/fund/list responses and the MCP
// face) carries `disputability: { status, reason, decider }` computed from
// current state, and that the field AGREES with the dispute path itself:
// for the configurations exercised here, the ones the field calls
// undisputable are the ones disputeBounty refuses dispute_unavailable,
// and a configuration the field calls disputable really opens a dispute
// with that decider seated. One deliberate, documented divergence: on a
// legacy row whose designee IS the poster (uncreatable today — postBounty
// refuses it at create time), the field is STRICTER than the dispute
// path: it reports undisputable / verifier_is_poster, applying the
// create-time third-party rule at read time, while disputeBounty itself,
// which has no poster check, would open the dispute and seat the poster.
//
// Harness pattern copied from tests/bounty-dispute-decider-visibility.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-disputability";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const CODEX = "id:agent/codex";
const OWNER = "owner";

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
    db.exec("SAVEPOINT disputability_test");
    try { const out = fn(); db.exec("RELEASE disputability_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO disputability_test"); db.exec("RELEASE disputability_test"); throw error; }
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

const expectCode = (fn, code, label = "") => {
  try { fn(); } catch (error) {
    assert.equal(error.code, code, `${label}expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`${label}expected EscrowError ${code}, no error thrown`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;

const ATTEST = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

// The field must be identical on every read face: detail and list.
function disputabilityOnEveryRead(escrow, bountyId) {
  const detail = escrow.getBounty(ROOM, bountyId);
  const listed = escrow.listBounties(ROOM).find(b => b.bountyId === bountyId);
  assert.ok(listed, "bounty present in list read");
  assert.deepEqual(listed.disputability, detail.disputability);
  return detail.disputability;
}

function runToAccepted(escrow, bounty, claimant = GROK) {
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
  return bounty;
}

test("a default bounty reads undisputable / no_decider_named from creation onward, on every read", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  // The post return is itself a bounty read: the truth is present at posting.
  assert.deepEqual(bounty.disputability,
    { status: "undisputable", reason: "no_decider_named", decider: null });
  assert.deepEqual(disputabilityOnEveryRead(escrow, bounty.bountyId),
    { status: "undisputable", reason: "no_decider_named", decider: null });
  // Funding does not change it, and the funded read still says so.
  const funded = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }).bounty;
  assert.deepEqual(funded.disputability,
    { status: "undisputable", reason: "no_decider_named", decider: null });
  assert.deepEqual(disputabilityOnEveryRead(escrow, bounty.bountyId),
    { status: "undisputable", reason: "no_decider_named", decider: null });
});

test("a third-party verifier reads disputable with that decider, from creation onward", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { verifierId: INSTINCT });
  assert.deepEqual(bounty.disputability, { status: "disputable", reason: null, decider: INSTINCT });
  const funded = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }).bounty;
  assert.deepEqual(funded.disputability, { status: "disputable", reason: null, decider: INSTINCT });
  assert.deepEqual(disputabilityOnEveryRead(escrow, bounty.bountyId),
    { status: "disputable", reason: null, decider: INSTINCT });
});

test("an explicit disputeDeciderId outranks the verifier in the field, as in disputeBounty", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { verifierId: INSTINCT, disputeDeciderId: CODEX });
  assert.deepEqual(bounty.disputability, { status: "disputable", reason: null, decider: CODEX });
  assert.deepEqual(disputabilityOnEveryRead(escrow, bounty.bountyId),
    { status: "disputable", reason: null, decider: CODEX });
});

test("when the verifier claims the work, the field flips to verifier_is_executor at claim time", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { verifierId: GROK });
  assert.deepEqual(bounty.disputability, { status: "disputable", reason: null, decider: GROK });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const claimed = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }).bounty;
  assert.deepEqual(claimed.disputability,
    { status: "undisputable", reason: "verifier_is_executor", decider: null });
  assert.deepEqual(disputabilityOnEveryRead(escrow, bounty.bountyId),
    { status: "undisputable", reason: "verifier_is_executor", decider: null });
});

test("a legacy row whose verifier is the poster reads verifier_is_poster", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  // postBounty refuses verifier == poster at create today; rows written
  // before that guard (or outside it) still carry the configuration. Write
  // one directly and read it back through the normal read shape.
  escrow.db.prepare("UPDATE bounty_records SET verifier=? WHERE bounty_id=?")
    .run(JILL, bounty.bountyId);
  assert.deepEqual(disputabilityOnEveryRead(escrow, bounty.bountyId),
    { status: "undisputable", reason: "verifier_is_poster", decider: null });
});

test("the field agrees with the dispute path: undisputable configurations refuse dispute_unavailable", () => {
  const { escrow } = makeEscrow();
  // No decider named.
  const plain = runToAccepted(escrow, post(escrow));
  assert.equal(escrow.getBounty(ROOM, plain.bountyId).disputability.status, "undisputable");
  expectCode(() => escrow.disputeBounty(ROOM, plain.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "looks off" }), "dispute_unavailable");
  // Verifier is the executor.
  const selfVerified = runToAccepted(escrow, post(escrow, { verifierId: GROK }), GROK);
  assert.equal(escrow.getBounty(ROOM, selfVerified.bountyId).disputability.reason, "verifier_is_executor");
  expectCode(() => escrow.disputeBounty(ROOM, selfVerified.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "looks off" }), "dispute_unavailable");
});

test("the field agrees with the dispute path: a disputable configuration opens with that decider seated", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, post(escrow, { verifierId: INSTINCT }));
  assert.deepEqual(escrow.getBounty(ROOM, bounty.bountyId).disputability,
    { status: "disputable", reason: null, decider: INSTINCT });
  const disputed = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "looks off" });
  assert.equal(disputed.bounty.state, "disputed");
  assert.equal(disputed.dispute.decider, INSTINCT);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
