// #3546/#3547 route contract: the delivered -> verified transition over the
// real work-claim routes — two-step completion under a reviewed policy, the
// reviewer's own verify call, the changes_requested send-back, the
// self-attested collapse, and the receipts projection that tells them apart.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { createDurableWorkClaimRegistry } from "../server/work-claim-sqlite.mjs";
import { claimHistoryLength, deliveryDigest, workOf } from "../server/work-claims.mjs";

import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const SHA = "a".repeat(64);
const bundle = { artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }], criteria: [] };
const auth = (id, kind, permissions) => ({ member: { id, kind, permissions } });
const OWNER = auth("owner", "human", ["manage_claims"]);
const WORKER = auth("worker", "agent", ["accept_work", "complete_work"]);
const REVIEWER = auth("reviewer", "agent", ["verify"]);

async function room(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, kind, permissions) => store.command(ownerKey, "commons",
    { id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind, permissions } });
  add("worker", "agent", ["accept_work", "complete_work"]);
  add("reviewer", "agent", ["verify"]);
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" || route === "receipts" ? "GET" : "POST", body },
    res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
  });
  const get = id => store.workClaims.get("commons", id);
  return { store, call, get, ownerKey };
}

async function claimed(t, id, create = {}) {
  const r = await room(t);
  await r.call("create", null, { id, title: `Task ${id}`, files: [`server/${id}.mjs`], ...create });
  await r.call("claim", id, { leaseHours: 6 }, { auth: WORKER });
  await r.call("update", id, { state: "in_progress" }, { auth: WORKER });
  return r;
}

test("reviewed policy: done from in_progress is refused with the two steps named", async t => {
  const r = await claimed(t, "two-step", { reviewPolicy: "distinct_member" });
  await assert.rejects(r.call("update", "two-step", { state: "done", delivery: bundle }, { auth: WORKER }),
    error => error.status === 422 && error.code === "work_not_delivered");
  assert.equal(r.get("two-step").state, "in_progress");
});

test("reviewed policy: deliver, review, verify — and the receipt tells verified from delivered", async t => {
  const r = await claimed(t, "verify-me", { reviewPolicy: "distinct_member" });
  const delivered = (await r.call("update", "verify-me", { state: "delivered", delivery: bundle }, { auth: WORKER })).value;
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.delivery.digest, deliveryDigest(bundle));
  // The owner of the claim cannot verify it, and neither can the room owner
  // who never reviewed it.
  await assert.rejects(r.call("update", "verify-me", { state: "done" }, { auth: WORKER }),
    error => error.status === 403 && error.code === "work_review_rejected");
  // The reviewer records the verdict against the delivery, then verifies
  // from their own session.
  await r.call("review", "verify-me", { verdict: "approve", summary: "bundle verified" }, { auth: REVIEWER });
  const done = (await r.call("update", "verify-me", { state: "done" }, { auth: REVIEWER })).value;
  assert.equal(done.state, "done");
  assert.equal(done.verification.state, "verified");
  assert.equal(done.verification.by, "reviewer");
  assert.deepEqual(done.verification.executedChecks.map(entry => entry.name), ["bundle_integrity"]);
  const receipts = (await r.call("receipts", null, undefined)).value.receipts;
  const receipt = receipts.find(entry => entry.workItemId === "verify-me");
  assert.equal(receipt.verification.state, "verified");
  assert.equal(receipt.deliveryDigest, deliveryDigest(bundle));
});

test("changes_requested: the reviewer sends a delivery back and the fact is recorded", async t => {
  const r = await claimed(t, "send-back", { reviewPolicy: "distinct_member" });
  await r.call("update", "send-back", { state: "delivered", delivery: bundle }, { auth: WORKER });
  await r.call("review", "send-back", { verdict: "changes_requested", summary: "criterion missing" }, { auth: REVIEWER });
  const back = (await r.call("update", "send-back", { state: "in_progress" }, { auth: REVIEWER })).value;
  assert.equal(back.state, "in_progress");
  assert.equal(back.verification.state, "changes_requested");
  assert.equal(back.verification.by, "reviewer");
});

test("reviewed policy: finishing without the bundle is refused naming the missing part", async t => {
  const r = await claimed(t, "bare-finish", { reviewPolicy: "distinct_member", acceptanceCriteria: ["docs updated"] });
  await assert.rejects(r.call("update", "bare-finish", { state: "delivered" }, { auth: WORKER }),
    error => error.status === 422 && error.code === "delivery_incomplete");
});

test("self_attested: one done call still lands, recorded as self-attested — never verified", async t => {
  const r = await claimed(t, "self-done");
  const done = (await r.call("update", "self-done", { state: "done", delivery: bundle, note: "shipped" }, { auth: WORKER })).value;
  assert.equal(done.state, "done");
  assert.equal(done.verification.state, "self_attested");
  const receipts = (await r.call("receipts", null, undefined)).value.receipts;
  const receipt = receipts.find(entry => entry.workItemId === "self-done");
  assert.equal(receipt.verification.state, "self_attested");
  assert.equal(receipt.deliveryDigest, deliveryDigest(bundle));
});

// Both reviewer exits must replay after leaving "delivered". Use the real
// direct handler and durable in-memory registry, without a server or client.
const reviewerExits = [
  { label: "verify", verdict: "approve", state: "done", verification: "verified" },
  { label: "send-back", verdict: "changes_requested", state: "in_progress", verification: "changes_requested" },
];

async function outcome(promise) {
  try { return await promise; }
  catch (error) {
    if (!Number.isInteger(error.status)) throw error;
    return { status: error.status, value: { error: { code: error.code } } };
  }
}

function effects(r, id) {
  const rows = table => r.store.db.prepare(`SELECT * FROM ${table}`).all();
  return {
    claim: r.get(id),
    claimRows: rows("work_claims"),
    events: rows("events"),
    room: r.store.room("commons"),
    wakes: Object.fromEntries(r.store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%wake%' OR name='jev_shadow_decisions') ORDER BY name"
    ).all().map(({ name }) => [name, rows(name)])),
  };
}

async function deliveredForRetry(t, exit, suffix) {
  const id = `retry-${exit.label}-${suffix}`;
  const r = await claimed(t, id, { reviewPolicy: "distinct_member" });
  await r.call("update", id, { state: "delivered", delivery: bundle }, { auth: WORKER });
  const request = { state: exit.state, requestId: `${id}-request` };
  return { r, id, request };
}

async function landReviewerExit(r, id, request, exit) {
  await r.call("review", id, { verdict: exit.verdict, summary: "retry regression review" }, { auth: REVIEWER });
  const first = await r.call("update", id, { ...request }, { auth: REVIEWER });
  assert.equal(first.status, 200, "the initial reviewer action must be authorized");
  assert.equal(first.value.state, exit.state);
  assert.equal(first.value.verification.state, exit.verification);
  assert.equal(first.value.verification.by, "reviewer");
  assert.ok(r.get(id).requestOutcomes[request.requestId], "the first call must record its requestId");
  assert.equal(first.value.updatedAt, first.value.verification.at, "sealing replay authority preserves the transition timestamp");
  return first;
}

function reviewerAccess(r, { permissions = ["verify"], active = true } = {}) {
  const member = r.store.roomAuthority("commons").members.reviewer;
  r.store.command(r.ownerKey, "commons", {
    id: `reviewer-access-${member.revision}`, type: "member.access_changed",
    data: { memberId: "reviewer", expectedMemberRevision: member.revision, permissions, active },
  });
}

for (const exit of reviewerExits) {
  test(`reviewer ${exit.label}: exact requestId retry returns 200 without another write`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "exact");
    await landReviewerExit(r, id, request, exit);
    const before = effects(r, id);
    const retry = await outcome(r.call("update", id, { ...request }, { auth: REVIEWER }));
    assert.deepEqual(effects(r, id), before, "retry must add no claim/history, room event, wake, or shadow effect");
    t.diagnostic(JSON.stringify({ action: exit.label, initialStatus: 200, retryStatus: retry.status,
      retryCode: retry.value.error?.code ?? null, historyDelta: 0, eventDelta: 0, wakeDelta: 0 }));
    assert.equal(retry.status, 200, `same authorized reviewer exact ${exit.label} retry must replay`);
    assert.deepEqual(retry.value, before.claim);
  });

  test(`reviewer ${exit.label}: replay does not authorize another or revoked member`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "auth");
    await landReviewerExit(r, id, request, exit);
    r.store.command(r.ownerKey, "commons", { id: `add-other-${exit.label}`, type: "member.added",
      data: { memberId: "other-reviewer", displayName: "Other reviewer", kind: "agent", permissions: ["verify"] } });
    const beforeOther = effects(r, id);
    const other = await outcome(r.call("update", id, { ...request }, { auth: auth("other-reviewer", "agent", ["verify"]) }));
    assert.equal(other.status, 403);
    assert.deepEqual(effects(r, id), beforeOther);
    for (const access of [{ permissions: [] }, { active: false }]) {
      reviewerAccess(r, access);
      const beforeRevoked = effects(r, id);
      // Keep the original auth object: the route must consult live authority.
      const revoked = await outcome(r.call("update", id, { ...request }, { auth: REVIEWER }));
      assert.equal(revoked.status, 403);
      assert.deepEqual(effects(r, id), beforeRevoked);
    }
  });

  test(`reviewer ${exit.label}: initial action requires the review and current permission`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "initial");
    const beforeReview = effects(r, id);
    const unreviewed = await outcome(r.call("update", id, { ...request }, { auth: REVIEWER }));
    assert.equal(unreviewed.status, 403);
    assert.equal(unreviewed.value.error.code, "work_review_rejected");
    assert.deepEqual(effects(r, id), beforeReview);
    await r.call("review", id, { verdict: exit.verdict, summary: "current authority control" }, { auth: REVIEWER });
    reviewerAccess(r, { permissions: [] });
    const beforeRevoked = effects(r, id);
    const revoked = await outcome(r.call("update", id, { ...request }, { auth: REVIEWER }));
    assert.equal(revoked.status, 403);
    assert.equal(revoked.value.error.code, "work_claims_not_permitted");
    assert.deepEqual(effects(r, id), beforeRevoked);
    reviewerAccess(r);
    const allowed = await r.call("update", id, { ...request }, { auth: REVIEWER });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.value.state, exit.state);
  });
}

// Replay authorization is exercised at the durable route boundary. These
// cases guard capabilities that an unscoped requestId replay must not grant.
for (const exit of reviewerExits) {
  test(`reviewer ${exit.label}: payload and reading ack stay bound after a registry reload`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "reload");
    Object.assign(request, { note: " verified\r\nreceipt ", readingAck: { docs: ["AGENTS.md"] },
      expectedClaimedAt: r.get(id).claimedAt, expectedHistoryLength: claimHistoryLength(r.get(id)) + 1 });
    await landReviewerExit(r, id, request, exit);
    // Exercise the persisted row codec plus the pure normalizer, rather than
    // retaining the route's returned JavaScript object as a fake reload.
    r.store.workClaims = createDurableWorkClaimRegistry(r.store.db);
    const loaded = r.get(id);
    r.store.workClaims.set("commons", workOf(loaded));
    const before = effects(r, id);
    assert.equal((await r.call("update", id, { ...request }, { auth: REVIEWER })).status, 200);
    assert.deepEqual(effects(r, id), before);
    for (const change of [{ note: "different" }, { state: "blocked" }, { readingAck: { docs: ["CONTRIBUTING.md"] } }, { readingAck: undefined }]) {
      const result = await outcome(r.call("update", id, { ...request, ...change }, { auth: REVIEWER }));
      assert.equal(result.status, 409);
      assert.equal(result.value.error.code, "work_claim_conflict");
      assert.deepEqual(effects(r, id), before);
    }
  });

  test(`reviewer ${exit.label}: legacy or malformed records confer no reviewer replay authority`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "legacy");
    await landReviewerExit(r, id, request, exit);
    const original = r.get(id);
    const record = original.requestOutcomes[request.requestId];
    for (const replacement of [record.at, { at: record.at, digest: record.digest },
      { ...record, reviewer: { actorId: "reviewer" } }, { ...record, reviewer: { ...record.reviewer, actorId: "other" } }]) {
      r.store.workClaims.set("commons", workOf({ ...original, requestOutcomes: { [request.requestId]: replacement } }));
      const before = effects(r, id);
      assert.equal((await outcome(r.call("update", id, request, { auth: REVIEWER }))).status, 403);
      assert.deepEqual(effects(r, id), before);
    }
    // An unbound old record cannot become a capability just because the
    // current state happens to admit a fresh reviewer transition.
    for (const replacement of [record.at, { at: record.at, digest: record.digest }]) {
      r.store.workClaims.set("commons", { ...original, state: "delivered", verification: null,
        requestOutcomes: { [request.requestId]: replacement } });
      const before = effects(r, id);
      assert.equal((await outcome(r.call("update", id, request, { auth: REVIEWER }))).status, 403);
      assert.deepEqual(effects(r, id), before);
    }
  });

  test(`reviewer ${exit.label}: current review authority is required even when broad review access remains`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "policy");
    await landReviewerExit(r, id, request, exit);
    const original = r.get(id);
    if (exit.state === "done") {
      // Still a board writer/reviewer, but no longer an independent verifier.
      reviewerAccess(r, { permissions: ["accept_work", "complete_work"] });
      r.store.workClaims.set("commons", { ...original, reviewPolicy: "independent_principal" });
    } else {
      await r.call("review", id, { verdict: "approve", summary: "withdraw the changes request" }, { auth: REVIEWER });
      // Isolate the review-authorization predicate from the history fence.
      r.store.workClaims.set("commons", { ...original, reviews: r.get(id).reviews, attestations: r.get(id).attestations });
    }
    const before = effects(r, id);
    const result = await outcome(r.call("update", id, request, { auth: REVIEWER }));
    assert.equal(result.status, 403);
    assert.equal(result.value.error.code, "work_review_rejected");
    assert.deepEqual(effects(r, id), before);
  });

  test(`reviewer ${exit.label}: a missing live permission field cannot reuse stale auth permissions`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "missing-permissions");
    await landReviewerExit(r, id, request, exit);
    const authority = r.store.roomAuthority.bind(r.store);
    r.store.roomAuthority = roomId => {
      const value = authority(roomId);
      const reviewer = { ...value.members.reviewer };
      delete reviewer.permissions;
      return { ...value, members: { ...value.members, reviewer } };
    };
    const before = effects(r, id);
    const result = await outcome(r.call("update", id, request, { auth: REVIEWER }));
    assert.equal(result.status, 403);
    assert.equal(result.value.error.code, "work_claims_not_permitted");
    assert.deepEqual(effects(r, id), before);
  });
}

test("owner replay keeps legacy timestamp and digest-only outcomes without new writes", async t => {
  const r = await claimed(t, "owner-legacy");
  const request = { state: "done", note: "shipped", requestId: "owner-done" };
  await r.call("update", "owner-legacy", request, { auth: WORKER });
  const item = r.get("owner-legacy"), record = item.requestOutcomes[request.requestId];
  for (const replacement of [record.at, { at: record.at, digest: record.digest }]) {
    r.store.workClaims.set("commons", { ...item, requestOutcomes: { [request.requestId]: replacement } });
    const before = effects(r, "owner-legacy");
    assert.equal((await r.call("update", "owner-legacy", request, { auth: WORKER })).status, 200);
    assert.deepEqual(effects(r, "owner-legacy"), before);
    const changed = await outcome(r.call("update", "owner-legacy", { ...request, note: "different" }, { auth: WORKER }));
    assert.equal(changed.status, typeof replacement === "string" ? 200 : 409);
    assert.deepEqual(effects(r, "owner-legacy"), before);
  }
});

test("send-back retry cannot cross identical-byte redelivery or same-millisecond release/reclaim", async t => {
  const exit = reviewerExits[1];
  const { r, id, request } = await deliveredForRetry(t, exit, "round");
  await landReviewerExit(r, id, request, exit);
  const original = r.get(id);
  // Bind a new clock to the original claimedAt so release/reclaim can use
  // the same timestamp; history is the independent round discriminator.
  r.store.now = () => Date.parse(original.claimedAt);
  const release = r.get(id);
  await r.call("release", id, { expectedClaimedAt: release.claimedAt, expectedHistoryLength: claimHistoryLength(release) }, { auth: WORKER });
  await r.call("claim", id, { leaseHours: 6 }, { auth: WORKER });
  await r.call("update", id, { state: "in_progress" }, { auth: WORKER });
  await r.call("update", id, { state: "delivered", delivery: bundle }, { auth: WORKER });
  assert.equal(r.get(id).claimedAt, original.claimedAt);
  assert.equal(r.get(id).delivery.digest, original.delivery.digest);
  assert.equal(r.get(id).deliveryGeneration, original.deliveryGeneration);
  await r.call("review", id, { verdict: "changes_requested", summary: "new round review" }, { auth: REVIEWER });
  const before = effects(r, id);
  assert.equal((await outcome(r.call("update", id, request, { auth: REVIEWER }))).status, 403);
  assert.deepEqual(effects(r, id), before);
  // A separately authorized request can send this round back. The old
  // request still cannot impersonate that newer verification fact.
  await r.call("update", id, { ...request, requestId: "new-round-back" }, { auth: REVIEWER });
  const after = effects(r, id);
  assert.equal((await outcome(r.call("update", id, request, { auth: REVIEWER }))).status, 403);
  assert.deepEqual(effects(r, id), after);
});

test("send-back retry fails closed after a later note or identical redelivery in the same claim round", async t => {
  const exit = reviewerExits[1];
  const { r, id, request } = await deliveredForRetry(t, exit, "later-edit");
  await landReviewerExit(r, id, request, exit);
  await r.call("update", id, { note: "later owner edit" }, { auth: WORKER });
  const afterNote = effects(r, id);
  assert.equal((await outcome(r.call("update", id, request, { auth: REVIEWER }))).status, 403);
  assert.deepEqual(effects(r, id), afterNote);
  await r.call("update", id, { state: "delivered", delivery: bundle }, { auth: WORKER });
  await r.call("review", id, { verdict: "changes_requested", summary: "new delivery round" }, { auth: REVIEWER });
  const afterDelivery = effects(r, id);
  assert.equal((await outcome(r.call("update", id, request, { auth: REVIEWER }))).status, 403);
  assert.deepEqual(effects(r, id), afterDelivery);
});

test("generation-zero approval still verifies only the first delivery and replays that success", async t => {
  const r = await claimed(t, "preapproved", { reviewPolicy: "distinct_member" });
  await r.call("review", "preapproved", { verdict: "approve", summary: "work reviewed before first delivery" }, { auth: REVIEWER });
  assert.equal(r.get("preapproved").reviews[0].basis.deliveryGeneration, 0);
  await r.call("update", "preapproved", { state: "delivered", delivery: bundle }, { auth: WORKER });
  const request = { state: "done", requestId: "preapproved-first" };
  await r.call("update", "preapproved", request, { auth: REVIEWER });
  const before = effects(r, "preapproved");
  assert.equal((await r.call("update", "preapproved", request, { auth: REVIEWER })).status, 200);
  assert.deepEqual(effects(r, "preapproved"), before);

  const s = await claimed(t, "preapproved-replaced", { reviewPolicy: "distinct_member" });
  await s.call("review", "preapproved-replaced", { verdict: "approve", summary: "pre-first-delivery approval" }, { auth: REVIEWER });
  await s.call("update", "preapproved-replaced", { state: "delivered", delivery: bundle }, { auth: WORKER });
  await s.call("update", "preapproved-replaced", { state: "in_progress" }, { auth: WORKER });
  await s.call("update", "preapproved-replaced", { state: "delivered", delivery: bundle }, { auth: WORKER });
  const beforeRejected = effects(s, "preapproved-replaced");
  const refused = await outcome(s.call("update", "preapproved-replaced", { state: "done", requestId: "must-not-land" }, { auth: REVIEWER }));
  assert.equal(refused.status, 403);
  assert.equal(refused.value.error.code, "work_review_rejected");
  assert.deepEqual(effects(s, "preapproved-replaced"), beforeRejected);
});

for (const exit of reviewerExits) {
  test(`reviewer ${exit.label}: failed ack and request-supplied provenance cannot mint replay authority`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "atomic");
    await r.call("review", id, { verdict: exit.verdict, summary: "authorized reviewer" }, { auth: REVIEWER });
    const before = effects(r, id);
    for (const extra of [{ readingAck: { docs: [] } }, { reviewer: { actorId: "reviewer" } },
      { requestOutcomes: { [request.requestId]: { actorId: "reviewer" } } }]) {
      const refused = await outcome(r.call("update", id, { ...request, ...extra }, { auth: REVIEWER }));
      assert.equal(refused.status, 422);
      assert.deepEqual(effects(r, id), before);
      assert.equal(r.get(id).requestOutcomes?.[request.requestId], undefined);
    }
    assert.equal((await r.call("update", id, request, { auth: REVIEWER })).status, 200);
    const after = effects(r, id);
    assert.equal((await r.call("update", id, request, { auth: REVIEWER })).status, 200);
    assert.deepEqual(effects(r, id), after);
  });
}

test("legacy nonowner self-attested completion keeps its first-call behavior", async t => {
  const r = await claimed(t, "legacy-self-reviewer", { reviewPolicy: "self_attested" });
  await r.call("update", "legacy-self-reviewer", { state: "delivered", delivery: bundle }, { auth: WORKER });
  // This legacy route behavior is not broadened into reviewer replay authority.
  const request = { state: "done", requestId: "legacy-self-reviewer-done" };
  const first = await r.call("update", "legacy-self-reviewer", request, { auth: REVIEWER });
  assert.equal(first.status, 200);
  assert.equal(first.value.verification.state, "self_attested");
  const before = effects(r, "legacy-self-reviewer");
  assert.equal((await outcome(r.call("update", "legacy-self-reviewer", request, { auth: REVIEWER }))).status, 403);
  assert.deepEqual(effects(r, "legacy-self-reviewer"), before);
});

for (const exit of reviewerExits) {
  test(`reviewer ${exit.label}: a numeric requestId survives a full outcome ledger`, async t => {
    const { r, id, request } = await deliveredForRetry(t, exit, "full-ledger");
    // Populate the persisted compatibility ledger; its 256-entry cap must
    // retain the just-landed key even though integer keys sort before strings.
    const stored = r.get(id);
    r.store.workClaims.set("commons", { ...stored, requestOutcomes: Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [`prior-${i}`, { at: stored.claimedAt, digest: "b".repeat(64) }])) });
    request.requestId = "1";
    await landReviewerExit(r, id, request, exit);
    assert.equal(Object.keys(r.get(id).requestOutcomes).length, 256);
    const before = effects(r, id);
    assert.equal((await r.call("update", id, request, { auth: REVIEWER })).status, 200);
    assert.deepEqual(effects(r, id), before);
  });
}


test("item-backed acceptance has one authority through delivery, approval and restartable reads", async t => {
  const r = await room(t);
  const send = (id, type, data) => r.store.command(r.ownerKey, "commons", { id, type, data });
  const item = () => r.store.room("commons").state.workItems.canonical;
  const mutate = (id, type, data = {}) => send(id, type, { workItemId: "canonical", expectedRevision: item().revision, ...data });
  send("propose-canonical", "work.proposed", { workItemId: "canonical", title: "Canonical result", definitionOfDone: "Reviewed exact evidence", accountableMemberId: "owner", humanDecisionMakerId: "owner", ownerDecisionRequired: true, mode: "read" });
  mutate("accept-canonical", "work.accepted");
  mutate("start-canonical", "work.started");
  const before = structuredClone(item());
  for (const [route, data] of [["update", { state: "done", delivery: bundle }], ["update", { state: "delivered", delivery: bundle }], ["review", { verdict: "approve", summary: "Skip evidence" }]]) {
    const result = await r.call(route, "canonical", data);
    assert.equal(result.status, 409);
    assert.equal(result.value.next[0].path, "/api/rooms/commons/work-context?workItemId=canonical");
    assert.deepEqual(item(), before);
  }
  mutate("complete-canonical", "work.completed", { summary: "Result", producerId: "owner", evidenceVersion: "v1", evidenceUrl: "https://example.com/result", nextAction: "Review", signedEvidence: makeTestSigner(r.store)() });
  assert.equal(r.get("canonical").state, "delivered");
  assert.equal(r.get("canonical").history.some(stamp => stamp.action === "state:done"), false);
  const receipt = item().receipt;
  send("rationale-canonical", "message.posted", { messageId: "rationale-canonical", body: "Checked and accepted this result." });
  const decision = { decision: "approved", completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion, reason: "Checked", sourceMessageId: "rationale-canonical" };
  assert.throws(() => mutate("stale-canonical", "owner.decision_recorded", { ...decision, expectedRevision: item().revision - 1 }), /revision/i);
  mutate("decision-canonical", "owner.decision_recorded", decision);
  assert.equal(r.get("canonical").state, "done");
  assert.equal(r.get("canonical").history.at(-1).action, "state:done");
  assert.equal(r.get("canonical").history.at(-1).agentId, "owner");
});
