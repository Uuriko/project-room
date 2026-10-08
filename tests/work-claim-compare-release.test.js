// Compare-and-release (collide guild P0-1): optional expectedClaimedAt /
// expectedHistoryLength on POST .../work-claims/{id}/release and .../update,
// generalizing the appendWorkPullRequest optimistic-concurrency pattern.
// A stale self-retry is otherwise indistinguishable from a fresh operation:
// claim -> release -> re-claim -> duplicate release all return 200, and the
// stale retry destroys the fresh re-claim while the agent believes it still
// holds it. With expectations provided, a moved claim is 409
// "The claim changed since it was read" instead.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";

const fakeHelpers = () => ({
  body: async req => req.body,
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  },
});

const openStore = t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  return store;
};

const runRoute = async ({ store, route, id, body = {}, memberId = "owner" }) => {
  const helpers = fakeHelpers();
  try {
    const out = await handleWorkClaims({
      req: { method: "POST", body },
      res: {}, url: new URL("http://localhost"), store, roomId: "commons",
      auth: { member: { id: memberId, kind: "human" } },
      workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
    });
    return { out, error: null };
  } catch (error) {
    return { out: null, error };
  }
};

const historyLengthOf = item => item.history.length + (item.historyOmitted ?? 0);

const setupClaimed = async (store, id = "w1") => {
  const created = await runRoute({ store, route: "create", body: { id, title: "t" } });
  assert.equal(created.error, null, `create failed: ${created.error?.message}`);
  const claimed = await runRoute({ store, route: "claim", id, body: { leaseHours: 1 } });
  assert.equal(claimed.error, null, `claim failed: ${claimed.error?.message}`);
  return store.workClaims.get("commons", id);
};

test("stale duplicate release after re-claim is a 409 and the re-claim survives", async t => {
  const store = openStore(t);
  const read = await setupClaimed(store);
  const staleBasis = { expectedClaimedAt: read.claimedAt, expectedHistoryLength: historyLengthOf(read) };
  const released = await runRoute({ store, route: "release", id: "w1", body: { reason: "first", ...staleBasis } });
  assert.equal(released.error, null, `release failed: ${released.error?.message}`);
  const reclaimed = await runRoute({ store, route: "claim", id: "w1", body: { leaseHours: 1 } });
  assert.equal(reclaimed.error, null, `re-claim failed: ${reclaimed.error?.message}`);
  // The stale self-retry: same body the first release used, but the claim
  // moved (release + re-claim) since that read.
  const dup = await runRoute({ store, route: "release", id: "w1", body: { reason: "stale retry", ...staleBasis } });
  assert.ok(dup.error, "expected a 409 work_claim_conflict, got success");
  assert.equal(dup.error.status, 409);
  assert.equal(dup.error.code, "work_claim_conflict");
  assert.match(dup.error.message, /changed since it was read/);
  const item = store.workClaims.get("commons", "w1");
  assert.equal(item.state, "claimed", "the stale retry must not destroy the fresh re-claim");
  assert.equal(item.owner, "owner");
});

test("fresh-basis release still succeeds", async t => {
  const store = openStore(t);
  const read = await setupClaimed(store);
  const fresh = await runRoute({ store, route: "release", id: "w1",
    body: { expectedClaimedAt: read.claimedAt, expectedHistoryLength: historyLengthOf(read) } });
  assert.equal(fresh.error, null, `fresh-basis release failed: ${fresh.error?.message}`);
  assert.equal(fresh.out.status, 200);
  assert.equal(store.workClaims.get("commons", "w1").state, "unclaimed");
});

test("release without expectations keeps legacy behavior", async t => {
  const store = openStore(t);
  await setupClaimed(store);
  const released = await runRoute({ store, route: "release", id: "w1", body: {} });
  assert.equal(released.error, null, `release failed: ${released.error?.message}`);
  assert.equal(store.workClaims.get("commons", "w1").state, "unclaimed");
});

test("stale update after release + re-claim is a 409 and the note does not land", async t => {
  const store = openStore(t);
  const read = await setupClaimed(store);
  const staleBasis = { expectedClaimedAt: read.claimedAt, expectedHistoryLength: historyLengthOf(read) };
  await runRoute({ store, route: "release", id: "w1", body: {} });
  await runRoute({ store, route: "claim", id: "w1", body: { leaseHours: 1 } });
  const stale = await runRoute({ store, route: "update", id: "w1", body: { note: "stale note", ...staleBasis } });
  assert.ok(stale.error, "expected a 409 work_claim_conflict, got success");
  assert.equal(stale.error.status, 409);
  assert.equal(stale.error.code, "work_claim_conflict");
  const item = store.workClaims.get("commons", "w1");
  assert.ok(!item.history.some(entry => entry.note === "stale note"), "the stale note must not land");
});

test("fresh-basis update still succeeds", async t => {
  const store = openStore(t);
  const read = await setupClaimed(store);
  const updated = await runRoute({ store, route: "update", id: "w1",
    body: { note: "fresh note", expectedClaimedAt: read.claimedAt, expectedHistoryLength: historyLengthOf(read) } });
  assert.equal(updated.error, null, `fresh-basis update failed: ${updated.error?.message}`);
  assert.equal(updated.out.status, 200);
});

test("malformed expectations are 422, not 409", async t => {
  const store = openStore(t);
  await setupClaimed(store);
  for (const body of [
    { expectedClaimedAt: 42 },
    { expectedClaimedAt: "not-a-date" },
    { expectedHistoryLength: -1 },
    { expectedHistoryLength: 1.5 },
    { expectedHistoryLength: "3" },
  ]) {
    const { error } = await runRoute({ store, route: "release", id: "w1", body });
    assert.ok(error, `expected a 422 for ${JSON.stringify(body)}`);
    assert.equal(error.status, 422, `expected 422, got ${error.status} for ${JSON.stringify(body)}`);
  }
  // The claim is untouched by the refused attempts.
  assert.equal(store.workClaims.get("commons", "w1").state, "claimed");
});
