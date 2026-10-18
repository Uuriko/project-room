// B4-HARDENING: Dot's exact-head QA reproducers against PR #4085
// (14135dc58) as failing-first tests. Each sequence is hers, run against
// the pure kernel; the controls are the arms she reported as behaving.
// D1: identical approval wording after a genuinely new delivery, with
//     the current expectedBasis, adds zero history and leaves Verify
//     unreachable — dedupe keyed on text across delivery generations.
// D2: send-back after the lease lapses leaves in_progress holding the
//     expired lease; the next sweep unclaims and clears ownership and
//     the delivery with it.
// D3: release/reclaim by the same owner at the same claimedAt advances
//     claimRound 1 -> 2 while the review basis stays equal, so a delayed
//     round-1 approval lands on round 2 and qualifies its delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { claimDeliverBody } from "../src/board-ui.js";
import { createWork, claimWork, updateWork, releaseWork, recordReview, canCloseWork,
  releaseExpired, isLeaseExpired, claimHistoryLength } from "../server/work-claims.mjs";

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

function deliveredItem(id, ref = "https://example.com/v1") {
  let item = createWork({ id, reviewPolicy: "distinct_member",
    acceptanceCriteria: ["tests green"] }, { agentId: "alice", now: now() });
  item = claimWork(item, "alice", { now: now() });
  item = updateWork(item, "alice", { state: "in_progress", now: now() });
  const body = claimDeliverBody(item, fields(ref), "alice");
  item = updateWork(item, "alice", { ...body, now: now() });
  assert.equal(item.state, "delivered");
  return item;
}

const basisOf = item => ({ version: 1, owner: item.owner, claimedAt: item.claimedAt,
  revision: null, headSha: null, deliveryDigest: item.delivery?.digest ?? null,
  deliveryGeneration: item.deliveryGeneration ?? 0, claimRound: item.claimRound ?? 0 });

// ---------- D1: re-approval across a delivery generation ----------

test("D1: identical approval wording with the current basis lands after a genuinely new delivery", () => {
  let item = deliveredItem("w-d1");
  item = recordReview(item, "bob", { verdict: "approve", summary: "LGTM", now: now() });
  assert.equal(item.reviews.find(r => r.memberId === "bob")?.basis.deliveryGeneration, 1);
  // A second reviewer sends it back; alice delivers a genuinely new bundle.
  item = updateWork(item, "carol", { state: "in_progress", authority: true, now: now() });
  const body2 = claimDeliverBody(item, fields("https://example.com/v2"), "alice");
  item = updateWork(item, "alice", { ...body2, now: now() });
  assert.equal(item.deliveryGeneration, 2, "the re-delivery is a new generation");
  // Bob re-approves with the same wording, naming the basis he read back.
  const historyBefore = item.history.length;
  const next = recordReview(item, "bob", { verdict: "approve", summary: "LGTM",
    expectedBasis: basisOf(item), now: now() });
  assert.equal(next.history.length, historyBefore + 1,
    "the deliberate re-review appends history instead of vanishing into the dedupe");
  assert.equal(next.reviews.find(r => r.memberId === "bob")?.basis.deliveryGeneration, 2,
    "the standing review rebinds to the new delivery");
  assert.equal(canCloseWork(next, "bob", { policy: "distinct_member", reviewMembers: ["bob"] }), true,
    "Verify is reachable again on the strength of the refreshed approval");
});

test("D1 control: an identical resubmission WITHOUT a named basis never refreshes the binding", () => {
  let item = deliveredItem("w-d1-blind");
  item = recordReview(item, "bob", { verdict: "approve", summary: "LGTM", now: now() });
  item = updateWork(item, "carol", { state: "in_progress", authority: true, now: now() });
  const body2 = claimDeliverBody(item, fields("https://example.com/v2"), "alice");
  item = updateWork(item, "alice", { ...body2, now: now() });
  const historyBefore = item.history.length;
  const next = recordReview(item, "bob", { verdict: "approve", summary: "LGTM", now: now() });
  assert.equal(next.history.length, historyBefore, "a blind retry is still a no-op");
  assert.equal(next.reviews.find(r => r.memberId === "bob")?.basis.deliveryGeneration, 1,
    "the old binding is untouched — the approval-binding invariant holds");
});

// ---------- D2: send-back across a lapsed lease ----------

const T0 = Date.parse("2026-10-18T10:00:00Z");
const HOUR = 3600 * 1000;

function leasedDelivered(id, leaseHours) {
  let item = createWork({ id, reviewPolicy: "distinct_member",
    acceptanceCriteria: ["tests green"] }, { agentId: "alice", now: T0 });
  item = claimWork(item, "alice", { leaseHours, now: T0 });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 });
  const body = claimDeliverBody(item, fields("https://example.com/v1"), "alice");
  item = updateWork(item, "alice", { ...body, now: T0 + 30 * 60000 });
  assert.equal(item.state, "delivered");
  return item;
}

test("D2: send-back after the lease lapses starts a truthful lease window — the sweep cannot reap it", () => {
  let item = leasedDelivered("w-d2", 1);
  const T2 = T0 + 2 * HOUR;
  assert.equal(isLeaseExpired(item, T2), false, "a delivered claim is outside the sweep");
  item = updateWork(item, "bob", { state: "in_progress", authority: true, now: T2 });
  assert.equal(item.state, "in_progress");
  assert.ok(Date.parse(item.leaseExpiresAt) > T2,
    "the sent-back claim holds a live lease, not the lapsed one");
  const swept = releaseExpired([item], T2);
  assert.equal(swept[0].state, "in_progress", "the sweep leaves the sent-back claim alone");
  assert.equal(swept[0].owner, "alice", "ownership survives the sweep");
  assert.ok(swept[0].delivery, "the delivery record survives the sweep");
});

test("D2 control: a within-lease send-back keeps the original lease untouched", () => {
  let item = leasedDelivered("w-d2-within", 4);
  const expiry = item.leaseExpiresAt;
  item = updateWork(item, "bob", { state: "in_progress", authority: true, now: T0 + HOUR });
  assert.equal(item.leaseExpiresAt, expiry, "a live lease is the owner's budget — send-back does not move it");
});

test("D2 control: a lease-less claim stays lease-less across a send-back", () => {
  let item = leasedDelivered("w-d2-none", null);
  assert.equal(item.leaseExpiresAt, null);
  item = updateWork(item, "bob", { state: "in_progress", authority: true, now: T0 + 48 * HOUR });
  assert.equal(item.leaseExpiresAt, null, "no lease is invented for a claim that opted out");
  const swept = releaseExpired([item], T0 + 48 * HOUR);
  assert.equal(swept[0].owner, "alice", "the lease-less claim retains its assignment");
});

// ---------- D3: same-timestamp round collision ----------

test("D3: a delayed round-1 approval is refused in round 2 after a same-timestamp release/reclaim", () => {
  const T = Date.parse("2026-10-18T12:00:00Z");
  let item = createWork({ id: "w-d3", reviewPolicy: "distinct_member",
    acceptanceCriteria: ["tests green"] }, { agentId: "alice", now: T });
  item = claimWork(item, "alice", { now: T });
  assert.equal(item.claimRound, 1);
  item = updateWork(item, "alice", { state: "in_progress", now: T });
  const body1 = claimDeliverBody(item, fields("https://example.com/v1"), "alice");
  item = updateWork(item, "alice", { ...body1, now: T });
  assert.equal(item.state, "delivered");
  const roundOneBasis = basisOf(item);
  // The round ends and restarts inside the same millisecond.
  item = releaseWork(item, "alice", { expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item), now: T });
  item = claimWork(item, "alice", { now: T });
  assert.equal(item.claimRound, 2, "the reclaim opens round 2");
  assert.equal(item.claimedAt, roundOneBasis.claimedAt, "the collision: claimedAt is identical across rounds");
  item = updateWork(item, "alice", { state: "in_progress", now: T });
  const body2 = claimDeliverBody(item, fields("https://example.com/v1"), "alice");
  item = updateWork(item, "alice", { ...body2, now: T });
  assert.equal(item.state, "delivered");
  // Bob's round-1 approval, composed against the round-1 basis, arrives late.
  assert.throws(
    () => recordReview(item, "bob", { verdict: "approve", summary: "LGTM", expectedBasis: roundOneBasis, now: T }),
    /basis|conflict/i,
    "the stale round-1 basis is a conflict in round 2, not an approval of it");
  assert.equal(item.reviews.length, 0, "no review landed from the stale submission");
  // A fresh approval naming the round-2 basis succeeds and can close.
  const next = recordReview(item, "bob", { verdict: "approve", summary: "LGTM",
    expectedBasis: basisOf(item), now: T });
  assert.equal(next.reviews.length, 1);
  assert.equal(canCloseWork(next, "bob", { policy: "distinct_member", reviewMembers: ["bob"] }), true);
});
