// B4-BOARD-BATCH PR-A: the B7 board-acceptance handoffs H2/H3/H4.
// H2 (B7 §3/G4): a round-2 delivery must never be swallowed by round-1's
// recorded requestOutcomes entry. The G4 sequence is encoded verbatim:
// round-1 deliver -> send-back -> release -> same-owner reclaim ->
// deliver again.
// H3 (B7 §3/G5): claimVerifyBody / claimDeliverBody carry the round basis
// (expectedClaimedAt + expectedHistoryLength) the route fences stale
// first submissions with.
// H4 (B7 §3/G6): deliverOutcomeConfirmed is the Deliver submit's
// reconcile readback — success only for a claim actually delivered with
// the submitted bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { claimDeliverBody, claimSendBackBody, claimVerifyBody, verifyRequestId, deliverOutcomeConfirmed } from "../src/board-ui.js";
import { createWork, claimWork, updateWork, releaseWork, reassignWork, releaseExpired, claimHistoryLength,
  requestReplayVerdict, updateRequestDigest } from "../server/work-claims.mjs";

const SHA = "a".repeat(64);
let clock = Date.parse("2026-10-18T10:00:00Z");
const now = () => (clock += 1000);

const fields = ref => {
  const form = new FormData();
  form.set("artifactKind", "report");
  form.set("artifactRef", ref);
  form.set("artifactSha256", SHA);
  form.append("checkName", "unit tests");
  form.append("checkResult", "pass");
  form.append("criterion", "met");
  return form;
};

// The G4 round-1 journey: create (reviewed policy, criteria-bearing),
// claim by alice, start, deliver bundle B through the real body builder.
function roundOneDelivered(id) {
  let item = createWork({ id, reviewPolicy: "distinct_member",
    acceptanceCriteria: ["tests green"] }, { agentId: "alice", now: now() });
  item = claimWork(item, "alice", { now: now() });
  item = updateWork(item, "alice", { state: "in_progress", now: now() });
  const body = claimDeliverBody(item, fields("https://example.com/r1"), "alice");
  item = updateWork(item, "alice", { ...body, now: now() });
  assert.equal(item.state, "delivered");
  assert.equal(item.deliveryGeneration, 1);
  return { item, body };
}

// Send-back (authorized reviewer) then release — the G4 round ending.
function sendBackAndRelease(item) {
  item = updateWork(item, "bob", { state: "in_progress", authority: true, now: now() });
  assert.equal(item.state, "in_progress");
  assert.ok(item.delivery, "the send-back keeps the delivery as the round's record");
  item = releaseWork(item, "alice", { expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item), now: now() });
  assert.equal(item.state, "unclaimed");
  assert.equal(item.deliveryGeneration, 0);
  return item;
}

function reclaimAndStart(item) {
  item = claimWork(item, "alice", { now: now() });
  item = updateWork(item, "alice", { state: "in_progress", now: now() });
  return item;
}

test("H2/G4: round-2 delivery with the identical bundle lands instead of being swallowed", () => {
  const { item: delivered, body: body1 } = roundOneDelivered("w-g4");
  let item = sendBackAndRelease(delivered);
  assert.equal(item.requestOutcomes?.[body1.requestId]?.round, 1,
    "the round-1 outcome is retained as a tombstone, stamped with round 1");
  assert.equal(item.claimRound, 1, "release does not advance the round — the next claim does");
  item = reclaimAndStart(item);
  assert.equal(item.claimRound, 2, "the re-claim opens round 2");
  const body2 = claimDeliverBody(item, fields("https://example.com/r1"), "alice");
  assert.notEqual(body2.requestId, body1.requestId,
    "the round-2 deliver derives a new operation id (the round basis moved)");
  const before = item;
  item = updateWork(item, "alice", { ...body2, now: now() });
  assert.equal(item.state, "delivered", "the identical bundle delivers in round 2");
  assert.ok(item.delivery, "the round-2 delivery is recorded");
  assert.notEqual(item.history.length, before.history.length, "the update applied, not replayed");
});

test("H2/G4 kernel lock: even a verbatim round-1 requestId cannot swallow or refuse round 2", () => {
  // API callers do not have to use the board's derivation: the kernel
  // clearing alone must kill the collision. Replaying round 1's exact
  // body (same requestId, identical bundle) in round 2 applies as the
  // new round's delivery, and a changed bundle under that id applies
  // too instead of throwing work_claim_conflict.
  const { item: delivered, body: body1 } = roundOneDelivered("w-g4-kernel");
  let item = reclaimAndStart(sendBackAndRelease(delivered));
  item = updateWork(item, "alice", { ...body1, now: now() });
  assert.equal(item.state, "delivered", "identical payload under the old id applies in the new round");

  const second = roundOneDelivered("w-g4-kernel-2");
  let item2 = reclaimAndStart(sendBackAndRelease(second.item));
  const changed = claimDeliverBody(item2, fields("https://example.com/CHANGED"), "alice");
  item2 = updateWork(item2, "alice", { ...changed, requestId: second.body.requestId, now: now() });
  assert.equal(item2.state, "delivered", "changed payload under the old id is a new delivery, not a conflict");
  assert.equal(item2.delivery.artifact.ref, "https://example.com/CHANGED");
});

test("H2: the round binding survives lease expiry and fresh assignment", () => {
  const { item: delivered, body } = roundOneDelivered("w-g4-paths");
  const digest = updateRequestDigest(body);
  // Same round: the recorded outcome still replays (exact retry intact).
  assert.equal(requestReplayVerdict(delivered.requestOutcomes, body.requestId, digest, delivered.claimRound), "replay");
  // Lease-expiry path: send the delivered claim back, let its lease lapse,
  // then re-claim — the new round answers the old record with null.
  const item = updateWork(delivered, "bob", { state: "in_progress", authority: true, now: now() });
  const [lapsed] = releaseExpired([item], Date.parse(item.leaseExpiresAt) + 1);
  const reclaimed = updateWork(claimWork(lapsed, "alice", { now: now() }), "alice", { state: "in_progress", now: now() });
  assert.equal(requestReplayVerdict(reclaimed.requestOutcomes, body.requestId, digest, reclaimed.claimRound), null,
    "after lease expiry + re-claim, round 1's outcome neither replays nor conflicts");
  // Fresh-assignment path: an unclaimed row assigned fresh opens a new
  // round too, with the same verdict.
  const assigned = reassignWork(lapsed, "alice", "carol", { authority: true, now: now() });
  assert.equal(assigned.claimRound, reclaimed.claimRound, "fresh assignment advances the round like a claim");
  assert.equal(requestReplayVerdict(assigned.requestOutcomes, body.requestId, digest, assigned.claimRound), null);
});

test("H2: requestId parts differing only past the 40-char truncation stay distinct", () => {
  const prefix = "w".repeat(45);
  const itemA = { id: `${prefix}-alpha`, claimedAt: "2026-10-18T10:00:00.000Z", history: [], deliveryGeneration: 0 };
  const itemB = { id: `${prefix}-omega`, claimedAt: "2026-10-18T10:00:00.000Z", history: [], deliveryGeneration: 0 };
  assert.notEqual(verifyRequestId(itemA, "rev-1"), verifyRequestId(itemB, "rev-1"),
    "claim ids sharing a 45-char prefix derive different verify ids");
  const bodyA = claimDeliverBody({ ...itemA, acceptanceCriteria: [] }, fields("https://example.com/x"), "alice");
  const bodyB = claimDeliverBody({ ...itemB, acceptanceCriteria: [] }, fields("https://example.com/x"), "alice");
  assert.notEqual(bodyA.requestId, bodyB.requestId,
    "claim ids sharing a 45-char prefix derive different deliver ids");
  assert.match(bodyA.requestId, /^[A-Za-z0-9_-]{1,128}$/, "the id still fits the route's requestId shape");
  const longMemberA = verifyRequestId(itemA, `${"m".repeat(45)}-one`);
  const longMemberB = verifyRequestId(itemA, `${"m".repeat(45)}-two`);
  assert.notEqual(longMemberA, longMemberB, "member ids sharing a long prefix stay distinct too");
});

test("H2: verify ids are round-bound — a new round is a new operation, a retry is the same one", () => {
  const item = { id: "w-r", state: "delivered", deliveryGeneration: 1,
    claimedAt: "2026-10-18T10:00:00.000Z", history: [{ action: "claimed" }] };
  assert.equal(verifyRequestId(item, "rev-1"), verifyRequestId(item, "rev-1"),
    "the same snapshot derives the same id (exact retry)");
  assert.notEqual(verifyRequestId(item, "rev-1"),
    verifyRequestId({ ...item, claimedAt: "2026-10-18T11:00:00.000Z" }, "rev-1"),
    "a re-claimed round derives a new verify id even at the same generation");
  assert.notEqual(verifyRequestId(item, "rev-1"),
    verifyRequestId({ ...item, history: [...item.history, { action: "noted" }] }, "rev-1"),
    "a moved history basis derives a new verify id");
});

test("H3/G5: verify and deliver bodies carry the displayed round basis", () => {
  const item = { id: "w-h3", state: "in_progress", owner: "alice",
    claimedAt: "2026-10-18T10:00:00.000Z", deliveryGeneration: 0,
    history: [{ action: "created" }, { action: "claimed" }, { action: "state:in_progress" }],
    historyOmitted: 2, acceptanceCriteria: ["tests green"] };
  const verify = claimVerifyBody(item, "rev-1");
  assert.equal(verify.expectedClaimedAt, item.claimedAt);
  assert.equal(verify.expectedHistoryLength, 5, "history length + omitted, as release/reassign compute it");
  const deliver = claimDeliverBody(item, fields("https://example.com/h3"), "alice");
  assert.equal(deliver.expectedClaimedAt, item.claimedAt);
  assert.equal(deliver.expectedHistoryLength, 5);
});

test("H3/G5: a stale first submission's basis no longer matches after release + reclaim", () => {
  const { item: delivered } = roundOneDelivered("w-h3-stale");
  const staleBody = claimDeliverBody(delivered, fields("https://example.com/r1"), "alice");
  let item = reclaimAndStart(sendBackAndRelease(delivered));
  // The exact comparison the update route performs before applying an
  // update carrying basis preconditions (work-claim-routes.mjs).
  const basisMatches = item.claimedAt === staleBody.expectedClaimedAt
    && claimHistoryLength(item) === staleBody.expectedHistoryLength;
  assert.equal(basisMatches, false,
    "the round-1 basis is stale in round 2, so the route refuses it as a conflict");
  item = updateWork(item, "alice", { ...claimDeliverBody(item, fields("https://example.com/r2"), "alice"), now: now() });
  assert.equal(item.state, "delivered", "the fresh round-2 submission still applies");
});

test("H4/G6: deliverOutcomeConfirmed only confirms the submitted bundle, delivered by the submitter", () => {
  const { item, body } = roundOneDelivered("w-h4");
  assert.equal(deliverOutcomeConfirmed(item, body, "alice"), true,
    "delivered by alice with the submitted bundle confirms");
  assert.equal(deliverOutcomeConfirmed(item, body, "bob"), false,
    "a delivery by someone else does not confirm alice's submit");
  const other = claimDeliverBody(item, fields("https://example.com/other"), "alice");
  assert.equal(deliverOutcomeConfirmed(item, other, "alice"), false,
    "a claim delivered with a different bundle does not confirm this submit");
  assert.equal(deliverOutcomeConfirmed({ ...item, state: "in_progress", delivery: null }, body, "alice"), false,
    "the G4 swallowed state (in_progress, no delivery) never confirms");
  assert.equal(deliverOutcomeConfirmed(null, body, "alice"), false);
});


test("send-back gets a fresh operation identity after same-owner release and redelivery", () => {
  const { item: first } = roundOneDelivered("sendback-reclaim");
  const firstBody = claimSendBackBody(first, "bob");
  let second = reclaimAndStart(sendBackAndRelease(first));
  second = updateWork(second, "alice", { ...claimDeliverBody(second, fields("https://example.com/r1"), "alice"), now: now() });
  const secondBody = claimSendBackBody(second, "bob");
  assert.equal(second.deliveryGeneration, first.deliveryGeneration);
  assert.notEqual(secondBody.requestId, firstBody.requestId,
    "the new round must not reuse the old reviewer's cross-round tombstone");
  assert.deepEqual(claimSendBackBody(second, "bob"), secondBody, "retrying an unchanged read stays identical");
});
