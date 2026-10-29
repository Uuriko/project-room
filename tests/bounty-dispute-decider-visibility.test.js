// F-X4-2 — the dispute decider must be visible where the bounty is read.
//
// Register claim (UT-MIXED X4, V1-confirmed with transferability): naming a
// verifier silently seats them as the dispute decider, but the bounty read
// shape reported `disputeDecider: null` at every stage for every seat, and
// the decide refusal ("only the seated decider may rule") never named the
// decider. The effective decider has always been the composition
// `disputeDecider ?? verifier` (see disputeBounty); this file pins that the
// READ shape discloses that same identity, disclose-only: the stored
// dispute_decider column is never rewritten by the disclosure, who may
// decide does not change, and the refusal now names the seated decider.
//
// Harness pattern copied from tests/bounty-identity.test.js (strict
// membership store double = production behavior).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-decider-visibility";
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
    db.exec("SAVEPOINT decider_visibility_test");
    try { const out = fn(); db.exec("RELEASE decider_visibility_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO decider_visibility_test"); db.exec("RELEASE decider_visibility_test"); throw error; }
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

// Every read face a seat can use returns the same escrow view shape: the
// post return value, getBounty (detail), and listBounties (list). The
// poster, the worker and any third member all read through these.
function deciderOnEveryRead(escrow, bountyId) {
  const detail = escrow.getBounty(ROOM, bountyId);
  const listed = escrow.listBounties(ROOM).find(b => b.bountyId === bountyId);
  assert.ok(listed, "bounty present in list read");
  return [detail.disputeDecider, listed.disputeDecider];
}

function runToAccepted(escrow, overrides = {}) {
  const bounty = post(escrow, overrides);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
  return bounty;
}

test("a verifier-only bounty discloses the verifier as its dispute decider on every read, at every stage", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { verifierId: INSTINCT });
  assert.equal(bounty.verifier, INSTINCT);
  // At creation (the post return is itself a bounty read).
  assert.equal(bounty.disputeDecider, INSTINCT);
  assert.deepEqual(deciderOnEveryRead(escrow, bounty.bountyId), [INSTINCT, INSTINCT]);

  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  assert.deepEqual(deciderOnEveryRead(escrow, bounty.bountyId), [INSTINCT, INSTINCT]);

  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
  assert.deepEqual(deciderOnEveryRead(escrow, bounty.bountyId), [INSTINCT, INSTINCT]);

  const disputed = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "looks off" });
  assert.equal(disputed.bounty.state, "disputed");
  assert.equal(disputed.dispute.decider, INSTINCT); // the seat itself, unchanged
  assert.deepEqual(deciderOnEveryRead(escrow, bounty.bountyId), [INSTINCT, INSTINCT]);
});

test("disclose-only: lifecycle re-saves never persist the verifier into the dispute_decider column", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { verifierId: INSTINCT });
  const row = escrow.db.prepare("SELECT dispute_decider FROM bounty_records WHERE bounty_id=?")
    .get(bounty.bountyId);
  assert.equal(row.dispute_decider, null); // storage untouched; only the view composes
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).disputeDecider, INSTINCT);
});

test("an explicit disputeDeciderId still takes precedence over the verifier in the read shape", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { verifierId: INSTINCT, disputeDeciderId: CODEX });
  assert.equal(bounty.disputeDecider, CODEX);
  assert.deepEqual(deciderOnEveryRead(escrow, bounty.bountyId), [CODEX, CODEX]);
});

test("a bounty with no verifier and no designated decider still reads disputeDecider null", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  assert.equal(bounty.disputeDecider, null);
  assert.deepEqual(deciderOnEveryRead(escrow, bounty.bountyId), [null, null]);
});

test("the decide refusal names the seated decider; authority itself is unchanged", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { verifierId: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "looks off" });

  // A non-decider member is refused, and the refusal names who CAN rule.
  const byMember = expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: CODEX, outcome: "upheld", reasonCodes: ["evidence-insufficient"] }), "not_authorized");
  assert.match(byMember.message, /only the seated decider may rule/);
  assert.ok(byMember.message.includes(INSTINCT),
    `refusal should name the seated decider ${INSTINCT}, got: ${byMember.message}`);

  // The poster (and challenger-side seats) get the same named refusal.
  const byPoster = expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: JILL, outcome: "upheld", reasonCodes: ["evidence-insufficient"] }), "not_authorized");
  assert.ok(byPoster.message.includes(INSTINCT),
    `refusal should name the seated decider ${INSTINCT}, got: ${byPoster.message}`);

  // The seated decider still rules — who may decide did not move.
  const { receipt } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(receipt.actor.id, INSTINCT);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
