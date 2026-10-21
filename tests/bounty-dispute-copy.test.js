// C-5 (Ruling 37): the posting-time dispute-path warning + honest copy.
//
// A dispute seats only the decider named at posting (the dispute decider,
// else the verifier), designation cannot be added later, and seating
// requires independence from both the challenger and the worker. Before
// C-5 a poster learned a bounty could never be disputed only by filing
// one — inside the challenge window. postBounty now computes seatability
// over current membership and warns on the post response; the warning
// never blocks the posting. These specimens pin both directions plus the
// two end-to-end truth checks (the warning fires exactly where a later
// dispute refuses, and stays silent where a later dispute seats).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-dispute-copy";
const JILL = "id:agent/jill";       // poster
const GROK = "id:agent/grokbot";    // worker
const INSTINCT = "id:agent/instinct"; // third agent
const OWNER = "owner";              // human member

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

const AGENT = name => ({ active: true, kind: "agent", displayName: name });
const HUMAN = name => ({ active: true, kind: "human", displayName: name });

function makeEscrow(members) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT dispute_copy_test");
    try { const out = fn(); db.exec("RELEASE dispute_copy_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO dispute_copy_test"); db.exec("RELEASE dispute_copy_test"); throw error; }
  };
  const store = {
    db, transaction, readTransaction: transaction, now: () => nowMs,
    roomAuthority: roomId => {
      assert.equal(roomId, ROOM);
      return { sequence: 1, ownerId: OWNER, members };
    },
  };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides });

const ATTEST = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

function runToAccepted(escrow, posted) {
  escrow.fundBounty(ROOM, posted.bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, posted.bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, posted.bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, posted.bounty.bountyId, { acceptor: JILL, verifierAttestation: ATTEST() });
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

test("two-member room, no decider named: post succeeds and warns the bounty can never be disputed", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [GROK]: AGENT("grokbot") });
  const posted = post(escrow);
  assert.equal(posted.bounty.poster, JILL);
  assert.equal(posted.warnings.length, 1);
  assert.match(posted.warnings[0], /no dispute decider was named at posting/);
  assert.match(posted.warnings[0], /can never be disputed/);
});

test("two-member room, verifier is the only other member: warns the named decider cannot sit", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [GROK]: AGENT("grokbot") });
  const posted = post(escrow, { verifierId: GROK });
  assert.equal(posted.warnings.length, 1);
  assert.match(posted.warnings[0], /cannot sit for work by the room's current members/);
});

test("two-member room, human decider named: warns — no agent member can do work the decider is independent of", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [OWNER]: HUMAN("owner") });
  const posted = post(escrow, { disputeDeciderId: OWNER });
  assert.equal(posted.warnings.length, 1);
  assert.match(posted.warnings[0], /cannot sit for work by the room's current members/);
});

test("three-member room, no decider named: warns — designation cannot be added later", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [GROK]: AGENT("grokbot"), [INSTINCT]: AGENT("instinct") });
  const posted = post(escrow);
  assert.equal(posted.warnings.length, 1);
  assert.match(posted.warnings[0], /no dispute decider was named at posting/);
});

test("three-member room, verifier named: no warning — the decider can sit for the worker's work", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [GROK]: AGENT("grokbot"), [INSTINCT]: AGENT("instinct") });
  const posted = post(escrow, { verifierId: INSTINCT });
  assert.deepEqual(posted.warnings, []);
});

test("human dispute decider named in a room with two agent members: no warning", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [GROK]: AGENT("grokbot"),
    [INSTINCT]: AGENT("instinct"), [OWNER]: HUMAN("owner") });
  const posted = post(escrow, { disputeDeciderId: OWNER });
  assert.deepEqual(posted.warnings, []);
});

test("truth check: the warned two-member bounty really does refuse its dispute as unavailable", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [GROK]: AGENT("grokbot") });
  const posted = post(escrow);
  assert.equal(posted.warnings.length, 1);
  runToAccepted(escrow, posted);
  expectCode(() => escrow.disputeBounty(ROOM, posted.bounty.bountyId,
    { challenger: JILL, bond: 2.5, grounds: "criterion-unmet: the work does not meet c1" }), "dispute_unavailable");
});

test("truth check: the unwarned three-member bounty really does seat its decider and open its dispute", () => {
  const escrow = makeEscrow({ [JILL]: AGENT("jill"), [GROK]: AGENT("grokbot"), [INSTINCT]: AGENT("instinct") });
  const posted = post(escrow, { verifierId: INSTINCT });
  assert.deepEqual(posted.warnings, []);
  runToAccepted(escrow, posted);
  const disputed = escrow.disputeBounty(ROOM, posted.bounty.bountyId,
    { challenger: JILL, bond: 2.5, grounds: "criterion-unmet: the work does not meet c1" });
  assert.equal(disputed.bounty.state, "disputed");
});
