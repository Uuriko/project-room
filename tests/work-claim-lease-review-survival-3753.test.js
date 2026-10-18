// #3753: delivered work under review must survive lease expiry.
//
// The 24h lease sweep (releaseExpired) auto-releases any active claim
// whose lease has lapsed and wipes the round: delivery, verification,
// CI stamp, reviews, attestations. Two live shapes lost real work:
//
//  (a) finish -> delivered -> reviewer sends it back (changes_requested)
//      -> state in_progress WITH the delivery retained as the record of
//      what was handed over. If the (unchanged) lease then lapses, the
//      sweep destroyed the retained delivery and the review fact.
//  (b) a claim that never went through finish (note-flow) but carries a
//      current-round review: the sweep erased the review with the claim.
//
// Rule pinned here: a lease does not lapse while a review recorded
// against the round's current basis is outstanding. Plain claims (no
// current review) still expire exactly as before — including a
// delivery-carrying claim whose review basis has moved (bug sweep
// 2026-10-16 F1: when the sweep does fire it still clears the round's
// delivery state, so the next claimant never inherits the bundle).
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, recordReview, recordCi, isLeaseExpired, releaseExpired }
  from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const SHA = "a".repeat(64);
const HEAD = "b".repeat(40);
const T0 = Date.parse("2026-10-18T00:00:00.000Z");
const H = 3600 * 1000;
const bundle = () => ({
  artifact: { kind: "text", ref: "room://artifacts/1", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [],
});
const start = (id, over = {}) => {
  const item = createWork({ id, reviewPolicy: "distinct_member", ...over }, { agentId: "quill" });
  const claimed = claimWork(item, "quill", { now: T0, leaseHours: 6 });
  return updateWork(claimed, "quill", { state: "in_progress", now: T0 });
};
// finish -> delivered -> changes_requested -> back to in_progress,
// delivery + review fact retained (mirrors work-claim-verified-state).
const sentBack = () => {
  const delivered = updateWork(start("w-sendback"), "quill",
    { state: "delivered", delivery: bundle(), deliveryMode: "result", now: T0 });
  const reviewed = recordReview(delivered, "sage",
    { verdict: "changes_requested", summary: "criterion 2 is not met", now: T0 });
  return updateWork(reviewed, "sage", { state: "in_progress", authority: true, now: T0 });
};

test("#3753 (a): a sent-back claim's lease does not lapse — delivery and review fact survive the sweep", () => {
  const back = sentBack();
  assert.equal(back.state, "in_progress");
  assert.ok(back.delivery, "send-back retains the delivery");
  assert.equal(back.verification.state, "changes_requested");
  assert.equal(isLeaseExpired(back, T0 + 7 * H), false);
  const [after] = releaseExpired([back], T0 + 7 * H);
  assert.equal(after.state, "in_progress");
  assert.equal(after.owner, "quill");
  assert.equal(after.delivery.digest, back.delivery.digest);
  assert.equal(after.verification.state, "changes_requested");
  assert.equal(after.reviews.length, 1);
});

test("#3753 (b): a claim with a current-basis review outstanding does not lapse", () => {
  const active = start("w-noted");
  const reviewed = recordReview(active, "sage", { verdict: "comment", summary: "looking at it", now: T0 });
  assert.equal(reviewed.reviews.length, 1);
  assert.equal(isLeaseExpired(reviewed, T0 + 7 * H), false);
  const [after] = releaseExpired([reviewed], T0 + 7 * H);
  assert.equal(after.state, "in_progress");
  assert.equal(after.owner, "quill");
  assert.equal(after.reviews.length, 1);
});

test("#3753 control: a plain claim with no delivery and no review still expires and sweeps", () => {
  const active = start("w-plain");
  assert.equal(isLeaseExpired(active, T0 + 7 * H), true);
  const [after] = releaseExpired([active], T0 + 7 * H);
  assert.equal(after.state, "unclaimed");
  assert.equal(after.owner, null);
});

test("#3753 control: a review whose basis has moved no longer holds the lease", () => {
  const active = start("w-stale");
  const reviewed = recordReview(active, "sage", { verdict: "comment", summary: "looking at it", now: T0 });
  // A new CI head moves the review basis (the review attested headSha null).
  const moved = recordCi(reviewed, { state: "success", headSha: HEAD }, T0).item;
  assert.equal(isLeaseExpired(moved, T0 + 7 * H), true);
  const [after] = releaseExpired([moved], T0 + 7 * H);
  assert.equal(after.state, "unclaimed");
});

test("#3753 route level: the list sweep does not report or apply a release to a sent-back claim", async () => {
  const helpers = {
    json: (res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (registry, route, id, body) => handleWorkClaims({
    req: { method: route === "list" ? "GET" : "POST", body }, res: {},
    url: new URL("https://room.example/api/rooms/room1/work-claims"),
    store: { roomAuthority: () => ({ members: {
      agent1: { id: "agent1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    } }) },
    roomId: "room1", auth: { member: { id: "agent1", kind: "agent", permissions: [] } },
    workClaimRoute: route, workClaimId: id, helpers, registry,
  });
  const registry = createWorkClaimRegistry();
  await call(registry, "create", null, { id: "seed" });
  const back = sentBack();
  registry.set("room1", { ...back, id: "under-review", leaseExpiresAt: "2020-01-01T00:00:00.000Z" });
  const plain = { ...start("w-route-plain"), id: "plain-lapsed", leaseExpiresAt: "2020-01-01T00:00:00.000Z" };
  registry.set("room1", plain);
  const listed = await call(registry, "list");
  assert.deepEqual(listed.value.swept, ["plain-lapsed"]);
  const kept = listed.value.claims.find(c => c.id === "under-review");
  assert.equal(kept.state, "in_progress");
  assert.ok(kept.delivery, "the swept listing still carries the delivery");
});
