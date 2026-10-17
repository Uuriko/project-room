// #3546/#3547 route contract: the delivered -> verified transition over the
// real work-claim routes — two-step completion under a reviewed policy, the
// reviewer's own verify call, the changes_requested send-back, the
// self-attested collapse, and the receipts projection that tells them apart.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { deliveryDigest } from "../server/work-claims.mjs";

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
  return { store, call, get };
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
