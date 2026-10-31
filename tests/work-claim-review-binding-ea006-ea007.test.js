// EA-006 / EA-007 regression tests (expert audit 2026-10-30, lanes/D7c F-3/F-4).
//
// EA-006: under distinct_member, an approve recorded while the item is
// still in_progress (basis deliveryDigest null, generation 0) used to
// satisfy the accept gate for the round's FIRST delivery — the receipt's
// verification.basis.deliveryDigest then named a digest no reviewer
// attested. Coordinator ruling (help wave 2026-10-31): EXPIRY-AT-DELIVERY
// — a pre-delivery approve expires for gating purposes when a delivery
// lands; the reviewer must approve the delivery that exists.
//
// EA-007: a reviewer's note-only attestation (attestWork / POST /review
// {note}) used to REPLACE their standing verdict (reviews became []), so
// their subsequent verify failed, with no warning. A note-only
// attestation must not clear a standing verdict.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork, recordReview, attestWork, canCloseWork, hasCurrentReview,
} from "../server/work-claims.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "f".repeat(64);
const T = Date.parse("2026-10-31T00:00:00.000Z");
const M = 60_000;
const goodBundle = { artifact: { kind: "text", ref: "room://artifacts/good", sha256: SHA_A },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [{ criterion: "tests green", status: "met" }] };
const goodBundle2 = { artifact: { kind: "text", ref: "room://artifacts/good-v2", sha256: SHA_B },
  checks: [{ name: "unit", result: "pass" }],
  criteria: [{ criterion: "tests green", status: "met" }] };
const opts = { policy: "distinct_member", reviewMembers: ["sage"] };

const inProgress = (id, at = T) => {
  let item = createWork({ id, reviewPolicy: "distinct_member", acceptanceCriteria: ["tests green"] },
    { agentId: "quill", now: at });
  item = claimWork(item, "quill", { now: at + M });
  item = updateWork(item, "quill", { state: "in_progress", now: at + 2 * M });
  return item;
};
const delivered = (id, at = T) => updateWork(inProgress(id, at), "quill",
  { state: "delivered", delivery: goodBundle, now: at + 3 * M });

// --- EA-006 ---------------------------------------------------------------

test("EA-006: a pre-delivery approve does not satisfy the gate for the first delivery", () => {
  let item = inProgress("ea006-first");
  item = recordReview(item, "sage", { verdict: "approve", summary: "reviewed in flight", now: T + 3 * M });
  assert.equal(item.reviews[0].basis.deliveryDigest, null);
  assert.equal(item.reviews[0].basis.deliveryGeneration, 0);
  // While no delivery exists the approval is still the standing review.
  assert.equal(hasCurrentReview(item, "sage"), true);
  item = updateWork(item, "quill", { state: "delivered", delivery: goodBundle, now: T + 4 * M });
  assert.equal(item.deliveryGeneration, 1);
  // Expiry-at-delivery: the sight-unseen approve no longer gates.
  assert.equal(hasCurrentReview(item, "sage"), false,
    "pre-delivery approve must expire when the first delivery lands");
  assert.equal(canCloseWork(item, "sage", opts), false,
    "pre-delivery approve must not satisfy the accept gate for that delivery");
  // Control: a fresh approve of the delivery that exists satisfies the gate.
  item = recordReview(item, "sage", { verdict: "approve", summary: "reviewed the delivered bundle", now: T + 5 * M });
  assert.equal(item.reviews[0].basis.deliveryDigest, item.delivery.digest);
  assert.equal(canCloseWork(item, "sage", opts), true);
  const done = updateWork(item, "sage", { state: "done", reviewedBy: "sage", authority: true, now: T + 6 * M });
  assert.equal(done.state, "done");
  assert.equal(done.verification.basis.deliveryDigest, item.delivery.digest);
});

test("EA-006 control: a post-delivery approve still stales on a replacement delivery", () => {
  let item = delivered("ea006-replaced");
  item = recordReview(item, "sage", { verdict: "approve", summary: "bundle A verified", now: T + 4 * M });
  assert.equal(canCloseWork(item, "sage", opts), true);
  item = updateWork(item, "quill", { state: "in_progress", now: T + 5 * M }); // send-back
  item = updateWork(item, "quill", { state: "delivered", delivery: goodBundle2, now: T + 6 * M });
  assert.equal(canCloseWork(item, "sage", opts), false);
});

// --- EA-007 ---------------------------------------------------------------

test("EA-007: a note-only attestation after a delivered approve preserves the verdict and the gate", () => {
  let item = delivered("ea007-delivered");
  item = recordReview(item, "sage", { verdict: "approve", summary: "bundle verified", now: T + 4 * M });
  const reviewAt = item.reviews[0].at;
  item = attestWork(item, "sage", { note: "clarifying note", now: T + 5 * M });
  assert.equal(item.reviews.length, 1, "note-only attestation must not delete the standing review");
  assert.equal(item.reviews[0].verdict, "approve");
  // The approve-bound attestation keeps the review's instant, so the
  // canCloseWork attestation.at === review.at binding still holds.
  const attestation = item.attestations.find(entry => entry.memberId === "sage");
  assert.equal(attestation.at, reviewAt);
  assert.equal(attestation.note, "clarifying note");
  assert.equal(canCloseWork(item, "sage", opts), true,
    "the reviewer who approved and then noted must still be able to verify");
});

test("EA-007: a note-only attestation after an in-flight approve preserves the verdict", () => {
  let item = inProgress("ea007-inflight");
  item = recordReview(item, "sage", { verdict: "approve", summary: "reviewed in flight", now: T + 3 * M });
  item = attestWork(item, "sage", { note: "one more observation", now: T + 4 * M });
  assert.equal(item.reviews.length, 1);
  assert.equal(item.reviews[0].verdict, "approve");
});

test("EA-007: a note-only attestation preserves a non-approve verdict too", () => {
  let item = delivered("ea007-changes");
  item = recordReview(item, "sage", { verdict: "changes_requested", summary: "needs work", now: T + 4 * M });
  item = attestWork(item, "sage", { note: "detail on the send-back", now: T + 5 * M });
  assert.equal(item.reviews.length, 1);
  assert.equal(item.reviews[0].verdict, "changes_requested");
});

test("EA-007 control: a note-only attestation with no standing verdict still records the note", () => {
  let item = delivered("ea007-no-verdict");
  item = attestWork(item, "sage", { note: "looked, no verdict yet", now: T + 4 * M });
  assert.deepEqual(item.reviews, []);
  assert.equal(item.attestations.length, 1);
  assert.equal(item.attestations[0].note, "looked, no verdict yet");
});

test("EA-007 control: a verdict-carrying review still replaces the standing verdict", () => {
  let item = delivered("ea007-replace");
  item = recordReview(item, "sage", { verdict: "approve", summary: "bundle verified", now: T + 4 * M });
  item = recordReview(item, "sage", { verdict: "changes_requested", summary: "found a problem after all", now: T + 5 * M });
  assert.equal(item.reviews.length, 1);
  assert.equal(item.reviews[0].verdict, "changes_requested");
  assert.equal(canCloseWork(item, "sage", opts), false);
});
