// Bug sweep 2026-10-16, claims-kernel F1 + F2 (both independently
// verified CONFIRMED): the delivery bundle's lifecycle across the paths
// that end or transfer a claim round.
//  F1 — the lease-expiry sweep (releaseExpired) left the previous
//       round's delivery, verification fact, and generation on the
//       swept claim; the next claimant finished bundle-less and the
//       stale bundle was frozen as THEIR delivery.
//  F2 — reassignWork nulled a delivered claim's bundle but kept the
//       delivered state; verify then stamped it "verified" with zero
//       executed checks under a reviewed policy. Reassigning an
//       in_progress claim after a send-back also destroyed the delivery
//       record the send-back deliberately retains.
// The invariant these tests pin: every round-ending path clears the
// round's delivery state the same way; a live round's delivery state
// transfers with the round; a delivered claim never changes hands in
// `delivered`; and verify under a reviewed policy fails closed when no
// delivery exists.
// Amendment 2026-10-18 (#3753): the lease sweep itself no longer fires
// while a review stands on the round's current basis — delivered work
// under review survives lease expiry. F1's first test below is amended
// to the composed rule: pause while the review is outstanding, full
// clearing once its basis has moved.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, updateWork, recordReview, recordCi, reassignWork, releaseWork, releaseExpired,
  canCloseWork, claimHistoryLength, ClaimError } from "../server/work-claims.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const T0 = Date.parse("2026-10-16T00:00:00.000Z");
const H = 3600 * 1000;
const BUNDLE = {
  artifact: { kind: "pull_request", ref: "https://github.com/Uuriko/project-room/pull/999",
    sha256: "a".repeat(64) },
  checks: [{ name: "unit tests", result: "pass" }],
  criteria: [{ criterion: "criterion A", status: "met" }],
};

// Alice claims a criteria-bearing claim under distinct_member (24h
// lease), delivers a complete bundle, and the reviewer sends it back:
// in_progress with the delivery retained as the record of the handover.
const buildSentBack = id => {
  let item = createWork({ id, title: id, reviewPolicy: "distinct_member",
    acceptanceCriteria: ["criterion A"] }, { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours: 24 });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 + H });
  item = updateWork(item, "alice", { state: "delivered", delivery: BUNDLE, now: T0 + 2 * H });
  item = recordReview(item, "dave", { verdict: "changes_requested", summary: "please fix", now: T0 + 3 * H });
  item = updateWork(item, "dave", { state: "in_progress", now: T0 + 3 * H, authority: true });
  assert.equal(item.state, "in_progress");
  assert.ok(item.delivery);
  assert.equal(item.verification?.state, "changes_requested");
  return item;
};

const buildDelivered = id => {
  let item = createWork({ id, title: id, reviewPolicy: "distinct_member",
    acceptanceCriteria: ["criterion A"] }, { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours: 24 });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 + H });
  item = updateWork(item, "alice", { state: "delivered", delivery: BUNDLE, now: T0 + 2 * H });
  assert.equal(item.state, "delivered");
  assert.equal(item.deliveryGeneration, 1);
  return item;
};

test("F1 as amended by #3753: the sweep pauses while the send-back review is outstanding; once its basis moves, the sweep clears the round's delivery state — the next owner cannot inherit the bundle", () => {
  const item = buildSentBack("f1-sweep");
  const aliceDigest = item.delivery.digest;
  // #3753 (2026-10-18): dave's changes_requested review still stands on
  // the round's current basis, so the 24h lapse does NOT release the
  // claim — the pre-#3753 sweep silently destroyed this delivered work
  // mid-review. The claim, its delivery, and the review fact survive.
  const [held] = releaseExpired([item], T0 + 25 * H);
  assert.equal(held.state, "in_progress");
  assert.equal(held.owner, "alice");
  assert.equal(held.delivery.digest, aliceDigest);
  assert.equal(held.verification?.state, "changes_requested");
  // Once the review basis moves (a new CI head lands), the pause ends:
  // the sweep fires and clears the round exactly as F1 requires.
  const moved = recordCi(held, { state: "success", headSha: "c".repeat(40) }, T0 + 25 * H).item;
  const [swept] = releaseExpired([moved], T0 + 25 * H);
  assert.equal(swept.state, "unclaimed");
  assert.equal(swept.owner, null);
  assert.equal(swept.delivery, null);
  assert.equal(swept.verification, null);
  assert.equal(swept.deliveryGeneration, 0);
  assert.equal(swept.ci, null);
  // Bob claims the swept item: nothing of Alice's round rides along,
  // and a bundle-less finish under a reviewed policy is refused.
  let bob = claimWork(swept, "bob", { now: T0 + 25 * H, leaseHours: 24 });
  assert.equal(bob.delivery, null);
  assert.equal(bob.deliveryGeneration, 0);
  bob = updateWork(bob, "bob", { state: "in_progress", now: T0 + 25 * H });
  throwsCode(() => updateWork(bob, "bob", { state: "delivered", now: T0 + 26 * H }), "delivery_incomplete");
  assert.ok(aliceDigest); // the digest existed pre-sweep; it is the sweep that must drop it
});

test("F1: sweep and manual release now clear the same delivery state", () => {
  const item = buildSentBack("f1-parity");
  const released = releaseWork(item, "alice", {
    expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: T0 + 4 * H });
  assert.equal(released.state, "unclaimed");
  assert.equal(released.delivery, null);
  assert.equal(released.verification, null);
  assert.equal(released.deliveryGeneration, 0);
});

test("F1: claimWork refuses to inherit delivery residue on an unclaimed item", () => {
  const delivered = buildDelivered("f1-residue");
  // A pool item carrying a previous round's delivery state (the shape
  // the pre-fix sweep produced). Claiming it opens a fresh round.
  const residue = { ...delivered, state: "unclaimed", owner: null, claimedAt: null,
    leaseStartAt: null, leaseExpiresAt: null };
  const claimed = claimWork(residue, "bob", { now: T0 + 30 * H, leaseHours: 24 });
  assert.equal(claimed.delivery, null);
  assert.equal(claimed.verification, null);
  assert.equal(claimed.deliveryGeneration, 0);
  assert.equal(claimed.ci, null);
});

test("F2: reassigning a delivered claim reopens the round — delivery retained, no verdict standing", () => {
  const item = buildDelivered("f2-reopen");
  const digest = item.delivery.digest;
  const moved = reassignWork(item, "alice", "carol", { now: T0 + 4 * H });
  assert.equal(moved.state, "in_progress");
  assert.equal(moved.owner, "carol");
  assert.equal(moved.delivery?.digest, digest);
  assert.equal(moved.delivery?.deliveredBy, "alice"); // still the record of Alice's handover
  assert.equal(moved.verification, null);
  assert.equal(moved.deliveryGeneration, 1);
  assert.deepEqual(moved.reviews, []);
  // The legitimate handover flow completes: Carol re-finishes (the
  // retained bundle is re-presented as the round's delivery), Dave
  // approves, and verify runs the platform's checks for real.
  let round = updateWork(moved, "carol", { state: "delivered", now: T0 + 5 * H });
  assert.equal(round.delivery?.deliveredBy, "carol");
  assert.equal(round.delivery?.digest, digest);
  round = recordReview(round, "dave", { verdict: "approve", summary: "looks complete", now: T0 + 6 * H });
  assert.equal(canCloseWork(round, "dave", { policy: "distinct_member", reviewMembers: ["dave"] }), true);
  const done = updateWork(round, "dave", { state: "done", authority: true,
    policy: "distinct_member", reviewedBy: "dave", now: T0 + 6 * H });
  assert.equal(done.state, "done");
  assert.equal(done.verification?.state, "verified");
  assert.deepEqual(done.verification.executedChecks.map(entry => `${entry.name}:${entry.result}`),
    ["bundle_integrity:pass", "criteria_coverage:pass"]);
});

test("F2: verify fails closed — a delivered claim with no delivery cannot be verified under a reviewed policy", () => {
  const item = buildDelivered("f2-stranded");
  // The state the pre-fix reassign manufactured (and any legacy row may
  // still carry): delivered, bundle-less, generation reset.
  const stranded = { ...item, delivery: null, verification: null, ci: null,
    deliveryGeneration: 0, reviews: Object.freeze([]), attestations: Object.freeze([]) };
  const approved = recordReview(stranded, "dave", { verdict: "approve", summary: "approved", now: T0 + 5 * H });
  assert.equal(canCloseWork(approved, "dave", { policy: "distinct_member", reviewMembers: ["dave"] }), true);
  throwsCode(() => updateWork(approved, "dave", { state: "done", authority: true,
    policy: "distinct_member", reviewedBy: "dave", now: T0 + 5 * H }), "delivery_incomplete");
});

test("F2: the fail-closed verify guard is policy-scoped — self_attested bundle-less verify still completes", () => {
  let item = createWork({ id: "f2-self", title: "f2-self", reviewPolicy: "self_attested" },
    { now: T0, agentId: "poster" });
  item = claimWork(item, "alice", { now: T0, leaseHours: 24 });
  item = updateWork(item, "alice", { state: "in_progress", now: T0 + H });
  item = updateWork(item, "alice", { state: "delivered", now: T0 + 2 * H });
  assert.equal(item.state, "delivered");
  assert.equal(item.delivery, null);
  const done = updateWork(item, "alice", { state: "done", now: T0 + 3 * H });
  assert.equal(done.state, "done");
  assert.equal(done.verification?.state, "self_attested");
});

test("F2 secondary: reassigning an in_progress claim after a send-back keeps the retained delivery record", () => {
  const item = buildSentBack("f2-retained");
  const digest = item.delivery.digest;
  const moved = reassignWork(item, "alice", "carol", { now: T0 + 4 * H });
  assert.equal(moved.state, "in_progress");
  assert.equal(moved.owner, "carol");
  assert.equal(moved.delivery?.digest, digest);
  assert.equal(moved.delivery?.deliveredBy, "alice");
  assert.equal(moved.verification?.state, "changes_requested");
  assert.equal(moved.deliveryGeneration, 1);
});
