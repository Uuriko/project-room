// Agent work exchange slice 10: submission fingerprinting + claim-graph
// correlation -> arbiter review packets.
//
// A normalized SHA-256 fingerprint is pinned on every submission; above-
// threshold correlation (duplicate fingerprints, repeat claimant<->poster
// pairs) creates a review packet with the matched bounties, the claim
// graph, and the evidence attached. REVIEW-ONLY: packets never auto-ban,
// auto-slash, or touch balances, bonds, or reputation — a human decides.
// Credits are valueless ledger units: no cash-out, no on-chain touch.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  BountyEscrow, bountyEscrowSchema, canonicalSubmissionOf, submissionHashOf, convergeBountyDeployedSchema,
} from "../server/bounty-escrow.mjs";

const ROOM = "room-review";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const CODEX = "id:agent/codex";     // second worker lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const fund = (escrow, bountyId) => escrow.fundBounty(ROOM, bountyId, { funder: JILL });
const claim = (escrow, bountyId, claimant = GROK) => escrow.claimBounty(ROOM, bountyId, { claimant });
const EVIDENCE_A = { evidenceUrl: "https://example.com/pr/101", evidenceKind: "work.completed",
  summary: "did the thing", checksClaimed: ["lint", "tests"], producerId: "grokbot" };
const EVIDENCE_B = { evidenceUrl: "https://example.com/pr/102", evidenceKind: "work.completed",
  summary: "did the other thing", checksClaimed: ["lint"], producerId: "codex" };
const submit = (escrow, bountyId, claimant, evidence) =>
  escrow.submitWork(ROOM, bountyId, { claimant, evidence });
const packetsFor = (escrow, bountyId) => escrow.getReviewPackets(ROOM, { bountyId });
// Slice-8-era schema: drop the slice-10 table chunks and the
// submission_hash column, the same chunk-aware way the module splits them.
const bountyEscrowSchemaForTest = () => bountyEscrowSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
  .filter(sql => !sql.includes("bounty_review_packets"))
  .map(sql => sql.replace("    submission_hash TEXT,\n", ""))
  .join(";\n") + ";";
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

test("the fingerprint is normalized: field order and checksClaimed order do not change it", () => {
  const shuffled = { summary: "did the thing", producerId: "grokbot",
    checksClaimed: ["tests", "lint"], evidenceKind: "work.completed",
    evidenceUrl: "https://example.com/pr/101" };
  assert.equal(canonicalSubmissionOf(shuffled), canonicalSubmissionOf(EVIDENCE_A));
  assert.equal(submissionHashOf(shuffled), submissionHashOf(EVIDENCE_A));
  assert.match(submissionHashOf(EVIDENCE_A), /^[0-9a-f]{64}$/);
  assert.notEqual(submissionHashOf(EVIDENCE_A), submissionHashOf(EVIDENCE_B),
    "different work hashes differently");
  assert.notEqual(submissionHashOf({ ...EVIDENCE_A, summary: "did the thing " }),
    submissionHashOf(EVIDENCE_A), "no trimming: near-duplicates hash differently");
});

test("a lone submission pins its fingerprint and creates no packet", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  fund(escrow, bounty.bountyId);
  claim(escrow, bounty.bountyId);
  const { bounty: submitted, packet } = submit(escrow, bounty.bountyId, GROK, EVIDENCE_A);
  assert.equal(packet, null);
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.submissionHash, submissionHashOf(EVIDENCE_A));
  assert.deepEqual(packetsFor(escrow, bounty.bountyId), []);
  assert.equal(escrow.getReviewPackets(ROOM).length, 0);
  expectConserved(escrow);
});

test("duplicate fingerprints create a review packet with the matched bounties and claim graph", () => {
  const { escrow } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A); // lone: no packet
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, CODEX);
  const before = escrow.balances(ROOM, CODEX);
  const { packet } = submit(escrow, b2.bountyId, CODEX, { ...EVIDENCE_A }); // identical work
  assert.ok(packet, "above-threshold correlation creates a packet");
  assert.match(packet.packetId, /^rpkt_/);
  assert.equal(packet.submissionHash, submissionHashOf(EVIDENCE_A));
  const types = packet.signals.map(s => s.type);
  assert.ok(types.includes("duplicate-submission"), `signals: ${types}`);
  const dupe = packet.signals.find(s => s.type === "duplicate-submission");
  assert.deepEqual(dupe.matchedBountyIds, [b1.bountyId]);
  // Matched bounties, graph, and evidence ride along for the arbiter.
  assert.equal(packet.matchedBounties.length, 1);
  assert.equal(packet.matchedBounties[0].bountyId, b1.bountyId);
  assert.equal(packet.matchedBounties[0].claimant, GROK);
  const lanes = new Set(packet.graph.nodes.map(n => n.lane));
  assert.ok(lanes.has(GROK) && lanes.has(CODEX) && lanes.has(JILL), "graph covers every involved lane");
  const grokNode = packet.graph.nodes.find(n => n.lane === GROK);
  assert.deepEqual([...grokNode.roles].sort(), ["claimant"]);
  assert.ok(packet.graph.edges.some(e => e.kind === "claimed-from" && e.bountyId === b2.bountyId));
  assert.equal(packet.evidence.evidenceUrl, EVIDENCE_A.evidenceUrl);
  assert.equal(packet.evidence.summary, EVIDENCE_A.summary);
  // The packet is frozen.
  assert.ok(Object.isFrozen(packet));
  assert.ok(Object.isFrozen(packet.graph.nodes));
  // REVIEW-ONLY: the submission still sits in review; balances, the locked
  // bond, and reputation are untouched.
  assert.equal(escrow.getBounty(ROOM, b2.bountyId).state, "submitted");
  const after = escrow.balances(ROOM, CODEX);
  assert.equal(after.payable, before.payable);
  assert.equal(after.locked, before.locked, "the claim bond stays locked — not slashed, not returned");
  assert.equal(after.reputation.completedBounties, 0);
  assert.equal(after.reputation.earnedCredits, 0);
  // The packet journals exactly once and is inspectable by bounty.
  const events = escrow.store.db.prepare(
    "SELECT COUNT(*) AS n FROM bounty_events WHERE room_id=? AND type='review.packet-created'").get(ROOM).n;
  assert.equal(events, 1);
  assert.equal(packetsFor(escrow, b2.bountyId).length, 1);
  assert.equal(packetsFor(escrow, b2.bountyId)[0].packetId, packet.packetId);
  expectConserved(escrow);
});

test("repeat claimant<->poster pairing correlates even with different work", () => {
  const { escrow } = makeEscrow();
  const b1 = post(escrow); fund(escrow, b1.bountyId); claim(escrow, b1.bountyId, GROK);
  submit(escrow, b1.bountyId, GROK, EVIDENCE_A);
  const b2 = post(escrow); fund(escrow, b2.bountyId); claim(escrow, b2.bountyId, GROK);
  // Different work, same claimant<->poster pairing: still above threshold.
  const { packet } = submit(escrow, b2.bountyId, GROK, EVIDENCE_B);
  assert.ok(packet);
  const types = packet.signals.map(s => s.type);
  assert.ok(types.includes("repeat-claimant-poster"), `signals: ${types}`);
  assert.ok(!types.includes("duplicate-submission"), "distinct work is not a duplicate");
  const repeat = packet.signals.find(s => s.type === "repeat-claimant-poster");
  assert.deepEqual(repeat.matchedBountyIds, [b1.bountyId]);
  // Still review-only: no state, balance, bond, or reputation movement.
  assert.equal(escrow.getBounty(ROOM, b2.bountyId).state, "submitted");
  assert.equal(escrow.balances(ROOM, GROK).locked, 2, "two claim bonds locked, neither slashed");
  expectConserved(escrow);
});

test("correlation is room-scoped: identical work in another room creates no packet", () => {
  const { escrow } = makeEscrow();
  const OTHER = "room-other";
  escrow.ensureGenesis(OTHER);
  const mk = room => {
    const b = escrow.postBounty(room, { poster: JILL, title: "T", criteria: "C",
      amount: 10, deadline: isoFuture(3_600_000) }).bounty;
    escrow.fundBounty(room, b.bountyId, { funder: JILL });
    escrow.claimBounty(room, b.bountyId, { claimant: GROK });
    return b;
  };
  const o1 = mk(OTHER);
  const { packet: p1 } = escrow.submitWork(OTHER, o1.bountyId, { claimant: GROK, evidence: EVIDENCE_A });
  assert.equal(p1, null);
  const r1 = mk(ROOM);
  const { packet: p2 } = escrow.submitWork(ROOM, r1.bountyId, { claimant: GROK, evidence: EVIDENCE_A });
  assert.equal(p2, null, "the other room's identical submission does not correlate");
  assert.equal(escrow.getReviewPackets(OTHER).length, 0);
  expectConserved(escrow);
});

test("convergence creates the packets table and persists fingerprints on a slice-8-era database", () => {
  // Simulate a deployed database from before slice 10: every slice-8 table
  // present, but no bounty_review_packets and no submission_hash column.
  const legacySchema = bountyEscrowSchemaForTest();
  const db = new DatabaseSync(":memory:");
  db.exec(legacySchema);
  convergeBountyDeployedSchema(db);
  const { escrow } = makeEscrow(db);
  assert.doesNotThrow(() => escrow.verifySchema(), "converged database verifies clean");
  // Fresh submissions fingerprint and persist on the converged schema.
  const bounty = post(escrow);
  fund(escrow, bounty.bountyId);
  claim(escrow, bounty.bountyId);
  const { bounty: submitted } = submit(escrow, bounty.bountyId, GROK, EVIDENCE_A);
  assert.equal(submitted.submissionHash, submissionHashOf(EVIDENCE_A));
  const stored = db.prepare("SELECT submission_hash FROM bounty_records WHERE bounty_id=?")
    .get(bounty.bountyId).submission_hash;
  assert.equal(stored, submissionHashOf(EVIDENCE_A));
  assert.doesNotThrow(() => escrow.verifySchema(), "still verifies clean after writes");
  expectConserved(escrow);
});
