// #3612 (R-1/R-9) characterization: bounty attestation / settlement /
// journal records, following the bounty-rubrics test pattern.
//
// Pins, on the stored records: the submission (evidence) stamp, the
// acceptance attestation stamp (rubric pin untouched), the journal
// attribute leg's stamp (outside the hash core — conservation still
// verifies every hash), and the free-miss settlement stamp. Facts are
// server-derived (poster principal; instance from the submission
// round); model/harness/environment are pinned claims.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyProvenance, bountyEscrowSchema, convergeBountyDeployedSchema } from "../server/bounty-escrow.mjs";
import { sessionInstanceIdFor } from "../server/records-provenance.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";       // poster
const GROK = "id:agent/grokbot";    // worker
const INSTINCT = "id:agent/instinct"; // designated verifier

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const RUBRIC = [
  { criterionId: "correctness", description: "the fix resolves the reported bug" },
  { criterionId: "tests", description: "regression tests cover the fix" },
];
const CITED = [
  { criterionId: "correctness", verdict: "pass" },
  { criterionId: "tests", verdict: "pass" },
];
const ev = () => ({ evidenceUrl: "https://example.com/pr/1", summary: "did the thing" });
const att = citations => ({ at: new Date(nowMs).toISOString(), note: "lgtm", citations });

function runToSubmitted(escrow, submitExtra = {}) {
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), rubric: RUBRIC }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence: ev(), ...submitExtra });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("submit stamps the stored evidence: poster principal, submission instance, claimed runtime", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow, { modelVersion: "model-x/1.2", harnessVersion: "harness/4", environment: "node-24/linux" });
  const provenance = bounty.evidence.provenance;
  assert.equal(provenance.authorizingPrincipalId, JILL); // (iii) the poster, from the stored bounty row
  assert.equal(provenance.sessionInstanceId, // (ii) the submission round, server-derived
    sessionInstanceIdFor("bounty-submission", [bounty.bountyId, GROK, bounty.submissionHash]));
  assert.equal(provenance.claimedModelVersion, "model-x/1.2"); // R-9, as a claim
  assert.equal(provenance.claimedHarnessVersion, "harness/4");
  assert.equal(provenance.claimedEnvironment, "node-24/linux");
  // The submission fingerprint is computed over the canonical evidence
  // fields only — the stamp never perturbs it.
  assert.equal(bounty.submissionHash.length, 64);
});

test("submit without a runtime report stamps null claims; a bad claim fails closed", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  assert.equal(bounty.evidence.provenance.claimedModelVersion, null);
  assert.equal(bounty.evidence.provenance.authorizingPrincipalId, JILL);
  const { escrow: escrow2 } = makeEscrow();
  const posted = escrow2.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  escrow2.fundBounty(ROOM, posted.bountyId, { funder: JILL });
  escrow2.claimBounty(ROOM, posted.bountyId, { claimant: GROK });
  assert.throws(() => escrow2.submitWork(ROOM, posted.bountyId,
    { claimant: GROK, evidence: ev(), modelVersion: "m".repeat(201) }),
    error => error.code === "invalid_input");
  assert.equal(escrow2.getBounty(ROOM, posted.bountyId).state, "claimed"); // nothing was submitted
});

test("accept stamps the attestation (rubric pin intact) and the journal attribute leg carries the submission stamp", () => {
  const { escrow, db } = makeEscrow();
  const submitted = runToSubmitted(escrow, { modelVersion: "model-x/1.2" });
  const accepted = escrow.acceptWork(ROOM, submitted.bountyId,
    { acceptor: JILL, verifierAttestation: att(CITED), modelVersion: "review-tool/9" }).bounty;
  // Attestation: the verifier's own stamp, beside the unchanged rubric pin (iv).
  assert.equal(accepted.attestation.rubricVersion, 1);
  assert.equal(accepted.attestation.rubricHash, accepted.rubric.hash);
  assert.equal(accepted.attestation.recordedBy, JILL);
  assert.equal(accepted.attestation.provenance.authorizingPrincipalId, JILL);
  assert.equal(accepted.attestation.provenance.sessionInstanceId,
    sessionInstanceIdFor("bounty-review", [submitted.bountyId, JILL, submitted.submissionHash]));
  assert.equal(accepted.attestation.provenance.claimedModelVersion, "review-tool/9");
  assert.notEqual(accepted.attestation.provenance.sessionInstanceId, submitted.evidence.provenance.sessionInstanceId);
  // Journal: both attribute legs carry the SUBMISSION's stamp in
  // provenance_json; pre-stamp kinds (genesis) stay NULL.
  const legs = db.prepare("SELECT provenance_json FROM bounty_journal WHERE room_id=? AND kind='attribute' AND bounty_id=?")
    .all(ROOM, submitted.bountyId);
  assert.equal(legs.length, 2);
  for (const leg of legs) assert.deepEqual(JSON.parse(leg.provenance_json), submitted.evidence.provenance);
  const genesis = db.prepare("SELECT provenance_json FROM bounty_journal WHERE room_id=? AND kind='genesis' LIMIT 1").get(ROOM);
  assert.equal(genesis.provenance_json, null);
  // history() surfaces the stamp on the movement receipt.
  const movement = escrow.history(ROOM, JILL).find(r => r.kind === "attribute" && r.bountyId === submitted.bountyId);
  assert.deepEqual(movement.provenance, submitted.evidence.provenance);
  // The stamp lives outside the hash core: conservation (which
  // recomputes every journal hash) still verifies.
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("free-miss settlement record carries the submission round's provenance and replays identically", () => {
  const { escrow } = makeEscrow();
  const submitted = runToSubmitted(escrow, { modelVersion: "model-x/1.2" });
  const rejected = escrow.rejectWork(ROOM, submitted.bountyId, { rejector: JILL, reason: "work judged bad" });
  const provenance = rejected.settlement.provenance;
  assert.equal(provenance.authorizingPrincipalId, JILL);
  // The settlement verdict names the round it settles: the same instance
  // the submission stamped, derivable from the stored row alone.
  assert.equal(provenance.sessionInstanceId, submitted.evidence.provenance.sessionInstanceId);
  assert.equal(provenance.sessionInstanceId,
    bountyProvenance("bounty-submission", { bountyId: submitted.bountyId, poster: JILL, submissionHash: submitted.submissionHash }, GROK).sessionInstanceId);
  assert.equal(provenance.claimedModelVersion, null); // a settlement stamps no new model claim
  const replay = escrow.rejectWork(ROOM, submitted.bountyId, { rejector: JILL, reason: "work judged bad" });
  assert.equal(replay.alreadySettled, true);
  assert.deepEqual(replay.settlement, rejected.settlement);
});

test("legacy journal without provenance_json converges: column re-added, stamps land, hashes verify", () => {
  // Simulate a pre-#3612 database: the current schema minus the
  // provenance column (the bounty-rubrics legacy-convergence pattern).
  const legacySchema = bountyEscrowSchema.replace("    track TEXT,\n    provenance_json TEXT\n", "    track TEXT\n");
  assert.notEqual(legacySchema, bountyEscrowSchema);
  const db = new DatabaseSync(":memory:");
  db.exec(legacySchema);
  // The production boot path rebuilds drifted tables to the exact DDL;
  // the request-time _migrateColumns fallback only adds the column.
  convergeBountyDeployedSchema(db);
  const { escrow } = makeEscrow(db);
  const bounty = runToSubmitted(escrow, { modelVersion: "model-x/1.2" });
  assert.equal(bounty.evidence.provenance.claimedModelVersion, "model-x/1.2");
  const cols = db.prepare("PRAGMA table_info(bounty_journal)").all().map(row => row.name);
  assert.ok(cols.includes("provenance_json"), "migration re-added the column");
  assert.equal(escrow.verifySchema(), true);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
