// W2-F2 (RES-0003 / RES-0005) — a bounty that can never be disputed must
// not be born in silence: the create, fund and claim act responses carry
// an explicit `warnings` array at the moment the configuration becomes
// undisputable, instead of the poster learning it only from a
// dispute_unavailable refusal after accepted, paid work.
//
// Register row 2 (F-S1a-3): default bounty born undisputable in silence
// (verifier/disputeDecider null, no warning on create/fund). Row 4
// (F-S2a-1): a dispute can never be opened in a two-person room — every
// designation a pair contains is absent, the poster (refused at create),
// or the executor (created silently, refused only at dispute time).
// DA3-P3 landed a computed `disputability` field on bounty READS; the
// W6-A production re-verification (2026-11-01, build 1ab906c3) confirmed
// the residual: create/fund bodies carry the field but NO warning. These
// tests pin the act-response warnings. No act is refused and no money
// path changes: post/fund/claim still succeed, disputes still refuse
// exactly as before, conservation is asserted at the end of each run.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-openability";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const INSTINCT = "id:agent/instinct";
const OWNER = "owner";

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(members) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT openability_test");
    try { const out = fn(); db.exec("RELEASE openability_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO openability_test"); db.exec("RELEASE openability_test"); throw error; }
  };
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
  return escrow;
}

const fullMembers = () => ({
  [JILL]: { active: true, kind: "agent", displayName: "jill" },
  [GROK]: { active: true, kind: "agent", displayName: "grokbot" },
  [INSTINCT]: { active: true, kind: "agent", displayName: "instinct" },
  [OWNER]: { active: true, kind: "human", displayName: "owner" },
});

// The two-person room of RES-0005: a human poster and one agent.
const pairMembers = () => ({
  [GROK]: { active: true, kind: "agent", displayName: "grokbot" },
  [OWNER]: { active: true, kind: "human", displayName: "owner" },
});

const expectCode = (fn, code) => {
  try { fn(); } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

// Pass attestation: at current main an accept carrying a fail verdict is
// refused outright (Flip-B), so the dispute scenario is accept-then-challenge.
const ATTEST = () => ({ at: new Date(nowMs).toISOString(), note: "reviewed",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

const warningText = result => (result.warnings ?? []).join("\n");

test("create and fund of a default bounty warn loudly that it can never be disputed (RES-0003)", () => {
  const escrow = makeEscrow(fullMembers());
  const posted = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) });
  assert.equal(posted.bounty.disputability.status, "undisputable");
  assert.match(warningText(posted), /never be disputed/i,
    `create response carries no undisputable warning: ${JSON.stringify(posted.warnings ?? null)}`);
  assert.match(warningText(posted), /decider/i);
  const funded = escrow.fundBounty(ROOM, posted.bounty.bountyId, { funder: JILL });
  assert.match(warningText(funded), /never be disputed/i,
    `fund response carries no undisputable warning: ${JSON.stringify(funded.warnings ?? null)}`);
  // The warning changes nothing else: the lifecycle and the dispute
  // refusal are exactly as before, and conservation holds.
  escrow.claimBounty(ROOM, posted.bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, posted.bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, posted.bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
  expectCode(() => escrow.disputeBounty(ROOM, posted.bounty.bountyId,
    { challenger: JILL, bond: 2.5, grounds: "criteria not met" }), "dispute_unavailable");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("create and fund of a disputable bounty carry no undisputable warning", () => {
  const escrow = makeEscrow(fullMembers());
  const posted = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000),
      verifierId: INSTINCT });
  assert.doesNotMatch(warningText(posted), /never be disputed/i);
  const funded = escrow.fundBounty(ROOM, posted.bounty.bountyId, { funder: JILL });
  assert.doesNotMatch(warningText(funded), /never be disputed/i);
});

test("two-person room: naming the only other member as verifier warns at create; their claim warns again (RES-0005)", () => {
  const escrow = makeEscrow(pairMembers());
  const posted = escrow.postBounty(ROOM,
    { poster: OWNER, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000),
      verifierId: GROK });
  // In a pair, the designee is the only possible worker: if they claim
  // (the only claim this bounty can ever receive), no dispute can ever
  // open. The create response must say so now, not at dispute time.
  assert.match(warningText(posted), /only other member/i,
    `create response silent about the pair trap: ${JSON.stringify(posted.warnings ?? null)}`);
  escrow.fundBounty(ROOM, posted.bounty.bountyId, { funder: OWNER });
  const claimed = escrow.claimBounty(ROOM, posted.bounty.bountyId, { claimant: GROK });
  assert.equal(claimed.bounty.disputability.reason, "verifier_is_executor");
  assert.match(warningText(claimed), /never be disputed/i,
    `claim response silent as the claim makes the bounty undisputable: ${JSON.stringify(claimed.warnings ?? null)}`);
  escrow.submitWork(ROOM, posted.bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, posted.bounty.bountyId, { acceptor: OWNER, verifierAttestation: ATTEST() });
  expectCode(() => escrow.disputeBounty(ROOM, posted.bounty.bountyId,
    { challenger: OWNER, bond: 2.5, grounds: "criteria not met" }), "dispute_unavailable");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("two-person room with no designation warns at create and fund (RES-0005, default leg)", () => {
  const escrow = makeEscrow(pairMembers());
  const posted = escrow.postBounty(ROOM,
    { poster: OWNER, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) });
  assert.match(warningText(posted), /never be disputed/i);
  const funded = escrow.fundBounty(ROOM, posted.bounty.bountyId, { funder: OWNER });
  assert.match(warningText(funded), /never be disputed/i);
});

test("a claim by a non-designee in a larger room carries no executor warning; a configured dispute still opens", () => {
  const escrow = makeEscrow(fullMembers());
  const posted = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000),
      verifierId: INSTINCT });
  escrow.fundBounty(ROOM, posted.bounty.bountyId, { funder: JILL });
  const claimed = escrow.claimBounty(ROOM, posted.bounty.bountyId, { claimant: GROK });
  assert.doesNotMatch(warningText(claimed), /never be disputed/i);
  escrow.submitWork(ROOM, posted.bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, posted.bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
  const disputed = escrow.disputeBounty(ROOM, posted.bounty.bountyId,
    { challenger: JILL, bond: 2.5, grounds: "criteria not met" });
  assert.equal(disputed.bounty.state, "disputed");
  assert.equal(disputed.dispute.decider, INSTINCT);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
