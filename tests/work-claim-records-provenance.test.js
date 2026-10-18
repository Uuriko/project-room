// #3612 (R-1/R-9) characterization: board claim review records —
// delivery (submission), verification (verdict), review and attestation
// records on server/work-claims.mjs, plus the route's session pin.
//
// Facts are kernel-derived: the session instance is the claim round
// (claim id + acting member + claimedAt + delivery digest acted on) and
// the authorizing principal is the member who created the claim.
// Model/harness/environment are the acting runtime's pinned claims.
// Following the bounty-rubrics pattern, stamps are asserted on the
// records themselves and through the workOf codec round-trip (what the
// durable registry persists).
import test from "node:test";
import assert from "node:assert/strict";
import { claimHistoryLength, createWork, claimWork, updateWork, recordReview, attestWork, workOf } from "../server/work-claims.mjs";
import { sessionInstanceIdFor } from "../server/records-provenance.mjs";

const NOW = Date.parse("2026-10-03T13:00:00Z");
const SHA = "a".repeat(64);
const BUNDLE = { artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }], criteria: [] };
const PRINCIPAL = "principal-pam"; // created the claim: the authorizing human
const WORKER = "worker-wes";
const REVIEWER = "reviewer-rue";

function deliveredClaim(extra = {}) {
  let item = createWork({ id: "prov-1", title: "Stamped work", reviewPolicy: "distinct_member" }, { now: NOW, agentId: PRINCIPAL });
  item = claimWork(item, WORKER, { now: NOW });
  item = updateWork(item, WORKER, { state: "in_progress", now: NOW });
  return updateWork(item, WORKER, { state: "delivered", delivery: BUNDLE, now: NOW + 1000, ...extra });
}

test("finish stamps the delivery: claim-round instance, creator principal, claimed runtime pinned", () => {
  const item = deliveredClaim({ claimedModelVersion: "model-x/1.2", claimedHarnessVersion: "harness/4", claimedEnvironment: "node-24/linux" });
  const provenance = item.delivery.provenance;
  assert.equal(provenance.authorizingPrincipalId, PRINCIPAL);
  assert.equal(provenance.sessionInstanceId,
    sessionInstanceIdFor("board-claim", ["prov-1", WORKER, item.claimedAt, ""]));
  assert.equal(provenance.claimedModelVersion, "model-x/1.2");
  assert.equal(provenance.claimedHarnessVersion, "harness/4");
  assert.equal(provenance.claimedEnvironment, "node-24/linux");
  // The bundle digest is exactly the pre-#3612 digest: provenance rides
  // beside it, never inside it.
  assert.equal(item.delivery.digest.length, 64);
  // The stamp survives the codec the durable registry round-trips through.
  assert.deepEqual(workOf(JSON.parse(JSON.stringify(item))).delivery.provenance, provenance);
});

test("recordReview stamps the review and its approve attestation with the reviewer's instance", () => {
  const item = deliveredClaim();
  const reviewed = recordReview(item, REVIEWER,
    { verdict: "approve", summary: "bundle verified", now: NOW + 2000, claimedModelVersion: "review-tool/9" });
  const review = reviewed.reviews.find(entry => entry.memberId === REVIEWER);
  assert.equal(review.provenance.authorizingPrincipalId, PRINCIPAL);
  assert.equal(review.provenance.claimedModelVersion, "review-tool/9");
  assert.equal(review.provenance.sessionInstanceId,
    sessionInstanceIdFor("board-claim", ["prov-1", REVIEWER, item.claimedAt, item.delivery.digest]));
  assert.notEqual(review.provenance.sessionInstanceId, item.delivery.provenance.sessionInstanceId);
  const attestation = reviewed.attestations.find(entry => entry.memberId === REVIEWER);
  assert.deepEqual(attestation.provenance, review.provenance);
  assert.deepEqual(workOf(JSON.parse(JSON.stringify(reviewed))).reviews[0].provenance, review.provenance);
});

test("attestWork stamps the attestation; verify stamps the verification fact", () => {
  let item = deliveredClaim();
  item = attestWork(item, REVIEWER, { note: "looks right", now: NOW + 2000, claimedEnvironment: "node-24/linux" });
  const attestation = item.attestations.find(entry => entry.memberId === REVIEWER);
  assert.equal(attestation.provenance.authorizingPrincipalId, PRINCIPAL);
  assert.equal(attestation.provenance.claimedEnvironment, "node-24/linux");
  item = recordReview(item, REVIEWER, { verdict: "approve", summary: "verified", now: NOW + 3000 });
  const done = updateWork(item, REVIEWER, { state: "done", now: NOW + 4000, authority: true, policy: "distinct_member",
    claimedModelVersion: "verify-harness/1" });
  assert.equal(done.verification.state, "verified");
  assert.equal(done.verification.by, REVIEWER);
  assert.equal(done.verification.provenance.authorizingPrincipalId, PRINCIPAL);
  assert.equal(done.verification.provenance.claimedModelVersion, "verify-harness/1");
  assert.deepEqual(workOf(JSON.parse(JSON.stringify(done))).verification.provenance, done.verification.provenance);
});

test("self-attested collapse stamps the verification in one step", () => {
  let item = createWork({ id: "prov-self", title: "Self work" }, { now: NOW, agentId: PRINCIPAL });
  item = claimWork(item, WORKER, { now: NOW });
  item = updateWork(item, WORKER, { state: "in_progress", now: NOW });
  const done = updateWork(item, WORKER, { state: "done", now: NOW + 1000, claimedModelVersion: "model-x/1.2" });
  assert.equal(done.verification.state, "self_attested");
  assert.equal(done.verification.provenance.claimedModelVersion, "model-x/1.2");
  assert.equal(done.verification.provenance.authorizingPrincipalId, PRINCIPAL);
});

test("the request digest binds the claimed runtime: same-claim retry replays, changed-claim retry conflicts", () => {
  let item = createWork({ id: "prov-idem", title: "Idempotent" }, { now: NOW, agentId: PRINCIPAL });
  item = claimWork(item, WORKER, { now: NOW });
  item = updateWork(item, WORKER, { state: "in_progress", now: NOW });
  const delivered = updateWork(item, WORKER,
    { state: "delivered", delivery: BUNDLE, requestId: "req-1", now: NOW + 1000, claimedModelVersion: "model-x/1.2" });
  const replay = updateWork(delivered, WORKER,
    { state: "delivered", delivery: BUNDLE, requestId: "req-1", now: NOW + 1000, claimedModelVersion: "model-x/1.2" });
  // Same payload + same claims: a replay — the recorded outcome is
  // returned, the delivery (stamp included) is identical, and no second
  // history entry is appended.
  assert.deepEqual(replay.delivery, delivered.delivery);
  assert.equal(claimHistoryLength(replay), claimHistoryLength(delivered));
  assert.equal(replay.requestOutcomes["req-1"].digest, delivered.requestOutcomes["req-1"].digest);
  assert.throws(() => updateWork(delivered, WORKER,
    { state: "delivered", delivery: BUNDLE, requestId: "req-1", now: NOW + 3000, claimedModelVersion: "model-y/9" }),
    error => error.code === "work_claim_conflict");
});

test("a malformed claimed value fails closed; a legacy record without provenance round-trips untouched", () => {
  const item = deliveredClaim();
  assert.throws(() => recordReview(item, REVIEWER,
    { verdict: "comment", summary: "note", now: NOW + 2000, claimedModelVersion: "m".repeat(201) }),
    error => error.code === "invalid_claim_input");
  // Pre-#3612 shape: a delivery with no provenance key at all.
  const legacy = JSON.parse(JSON.stringify(item));
  delete legacy.delivery.provenance;
  legacy.verification = null;
  const roundTripped = workOf(legacy);
  assert.equal(Object.hasOwn(roundTripped.delivery, "provenance"), false);
});

// --- route level: the session environment pin ---------------------------
// The board route pins the environment the worker's session declared at
// session start (stored on the work item's attempt record) onto the
// delivery stamp when the update body reports none — the session's
// floating environment claim lands on the consequential record.
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";

const auth = (id, kind, permissions) => ({ member: { id, kind, permissions } });
const OWNER = auth("owner", "human", ["manage_claims"]);
const WORKER_AUTH = auth("worker", "agent", ["accept_work", "complete_work"]);

test("route: delivery stamp pins the work session's declared environment and the body's model claim", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-worker", type: "member.added",
    data: { memberId: "worker", displayName: "worker", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  // A room work item under the claim's id, with a live session by worker
  // (the item's accountable member — sessions are driven by the
  // accountable member or a steerer) that declared its environment at
  // session start.
  store.command(ownerKey, "commons", { id: "propose-pin-1", type: "work.proposed",
    data: { workItemId: "pin-1", title: "Pin task", definitionOfDone: "Stamped delivery", accountableMemberId: "worker", mode: "write" } });
  const workerKey = store.issueAccessKey("commons", "worker");
  store.mutateWorkSession(workerKey, "commons",
    { requestId: "sess-start-1", workItemId: "pin-1", action: "set_status", status: "processing", environment: "node-24/linux-x64" });
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
  });
  await call("create", null, { id: "pin-1", title: "Pin task", files: ["server/pin-1.mjs"] });
  await call("claim", "pin-1", { leaseHours: 6 }, { auth: WORKER_AUTH });
  await call("update", "pin-1", { state: "in_progress" }, { auth: WORKER_AUTH });
  const delivered = (await call("update", "pin-1",
    { state: "delivered", delivery: BUNDLE, modelVersion: "model-x/1.2" }, { auth: WORKER_AUTH })).value;
  const provenance = delivered.delivery.provenance;
  assert.equal(provenance.claimedEnvironment, "node-24/linux-x64"); // pinned from the session record, not the body
  assert.equal(provenance.claimedModelVersion, "model-x/1.2"); // the body's own claim
  assert.equal(provenance.authorizingPrincipalId, "owner"); // the claim's creator
  assert.match(provenance.sessionInstanceId, /^sess_[0-9a-f]{24}$/);
  // And it is the stored record, not just the response.
  assert.deepEqual(store.workClaims.get("commons", "pin-1").delivery.provenance, provenance);
  // The board LIST projection stays lean: stamps are audit detail served
  // by the claim read, not board payload.
  const listed = (await call("list", null, undefined)).value.claims.find(claim => claim.id === "pin-1");
  assert.equal(listed.delivery.provenance, undefined);
  const read = (await call("read", "pin-1", undefined)).value;
  assert.deepEqual((read.claim ?? read).delivery.provenance, provenance);
});
