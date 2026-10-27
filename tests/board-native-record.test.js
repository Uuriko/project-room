// Board-native record path (#3795): a claim created on the board (no legacy
// workItemId) must open to its record from its card, and the delivered end of
// the lifecycle must be actionable from the board — the review form renders
// on delivered claims (the kernel's recordReview accepts them), the reviewer
// who holds a current approval gets a verify control, and the holder under a
// reviewed policy finishes to delivered instead of being refused at done.
// The record itself is the card's record disclosure: acceptance criteria,
// evidence, delivery, verification and history, rendered from the same claim
// object the board list already carries — one record model, no projection.
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, canReviewClaim, currentApprovalFor } from "../src/board-ui.js";
import { needsMeHtml } from "../src/board-mine.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const T0 = "2026-10-16T10:00:00.000Z";
const DIGEST = "a".repeat(64);

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-2": { id: "rev-2", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
};
const reviewer = { id: "rev-1", manage: false, owner: false, write: true };
const worker = { id: "agent-1", manage: false, owner: false, write: true };

const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "in_progress", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, ...extra,
});
const render = (items, viewer, opts = {}) => boardHtml(items, null, viewer, members, NOW, opts);

// --- #3795: the card title is the path into the record ---

test("a board-native claim title links to the claim's own record", () => {
  const html = render([claim("wc_1")], reviewer);
  assert.match(html, /<a[^>]*href="#pr-record\/work\/wc_1"[^>]*data-open-work="wc_1"/,
    "the title anchor targets the record route with the claim id");
  assert.match(html, /data-open-claim="wc_1"/, "the anchor is marked as a claim record link");
});

test("a claim linked to a legacy work item still opens the work item record", () => {
  const linked = claim("wc_2", { workItemId: "w9" });
  const html = render([linked], reviewer, { workItems: { w9: { id: "w9", title: "Legacy item" } } });
  assert.match(html, /data-open-work="w9"/, "the legacy target wins when it resolves");
  assert.doesNotMatch(html, /data-open-claim/, "no claim fallback is claimed for a legacy link");
});

test("dependency references link only to claims the board places", () => {
  const oldDone = claim("old-done", { state: "done", owner: "agent-1", updatedAt: "2026-09-01T00:00:00.000Z" });
  const live = claim("live-dep", { state: "claimed" });
  const dependent = claim("wc_10", { dependsOn: ["old-done", "live-dep"] });
  const html = render([dependent, oldDone, live], reviewer);
  assert.doesNotMatch(html, /data-open-claim="old-done"/,
    "a claim aged off the board keeps a plain-text reference instead of a link whose reveal would fail");
  assert.match(html, /data-open-claim="live-dep"/, "a placed claim's reference opens its record");
});

test("the card carries a record disclosure with criteria, evidence and history", () => {
  const item = claim("wc_3", {
    acceptanceCriteria: ["Done when the tests pass"],
    evidenceRefs: ["https://example.com/evidence/1"],
    history: [
      { action: "created", agentId: "agent-1", at: T0, note: "Picked up from the board" },
      { action: "state:in_progress", agentId: "agent-1", at: T0, note: "" },
    ],
    historyOmitted: 3,
  });
  const html = render([item], reviewer);
  assert.match(html, /<details class="claim-record" data-claim-record="wc_3">/);
  assert.match(html, /Done when the tests pass/, "acceptance criteria are on the record");
  assert.match(html, /https:\/\/example\.com\/evidence\/1/, "evidence refs are on the record");
  assert.match(html, /Picked up from the board/, "history notes are on the record");
  assert.match(html, /3 earlier/, "truncated history is disclosed, not silently dropped");
});

test("the record disclosure shows the delivery bundle on a delivered claim", () => {
  // The kernel's stored shape (#3547): the bundle's artifact / checks /
  // criteria plus digest / deliveredBy / deliveredAt — no "result" field
  // exists on a delivery (an earlier fixture invented one, and the record
  // rendered it while real evidence stayed hidden).
  const item = claim("wc_4", {
    state: "delivered",
    pullRequest: { url: "https://github.com/o/r/pull/7" },
    delivery: { artifact: { kind: "report", ref: "https://example.com/results/wc_4", sha256: DIGEST },
      checks: [{ name: "unit", result: "pass" }], criteria: [{ criterion: "Done when the tests pass", status: "met" }],
      digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 },
    deliveryGeneration: 1,
  });
  const html = render([item], reviewer);
  assert.match(html, /https:\/\/example\.com\/results\/wc_4/, "the delivered artifact is on the record");
  assert.match(html, /unit/, "the delivered checks are on the record");
  assert.match(html, /data-claim-record="wc_4"/);
});

// --- delivered claims are reviewable and verifiable from the board ---

test("canReviewClaim accepts a delivered claim (the kernel reviews active or delivered)", () => {
  assert.equal(canReviewClaim(claim("wc_5", { state: "delivered" }), reviewer, members), true);
  const html = render([claim("wc_5", { state: "delivered", pullRequest: { url: "https://github.com/o/r/pull/7" } })], reviewer);
  assert.match(html, /data-claim-review="wc_5"/, "the review form renders on the delivered card");
});

const deliveredBundle = (digest = DIGEST) => ({
  artifact: { kind: "report", ref: "https://example.com/results/claim", sha256: DIGEST },
  checks: [{ name: "unit", result: "pass" }], criteria: [],
  digest, deliveredBy: "agent-1", deliveredAt: T0,
});
const approvedDelivered = (id, extra = {}) => claim(id, {
  // A reviewed-policy claim: approval-based verify exists only there —
  // under self_attested the kernel closes owner-only (B4 #3885/#3887
  // made the board's verify gate policy-aware; the fixture now names
  // the policy its scenario always modelled).
  reviewPolicy: "distinct_member",
  state: "delivered",
  pullRequest: { url: "https://github.com/o/r/pull/7" },
  delivery: deliveredBundle(),
  deliveryGeneration: 1,
  reviews: [{ memberId: "rev-1", verdict: "approve", summary: "looks right", at: "2026-10-16T11:00:00.000Z",
    basis: { version: 1, owner: "agent-1", claimedAt: T0, revision: null, headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 1 } }],
  attestations: [{ memberId: "rev-1", at: "2026-10-16T11:00:00.000Z", note: "looks right" }],
  ...extra,
});

test("currentApprovalFor mirrors the kernel's basis currency incl. the delivery binding", () => {
  assert.ok(currentApprovalFor(approvedDelivered("wc_6"), "rev-1"), "approval against the current delivery counts");
  const redelivered = approvedDelivered("wc_6", { delivery: deliveredBundle("b".repeat(64)), deliveryGeneration: 2 });
  assert.equal(currentApprovalFor(redelivered, "rev-1"), null, "a re-delivery stales an approval bound to the old digest");
  assert.equal(currentApprovalFor(approvedDelivered("wc_6"), "rev-2"), null, "another member's approval is not yours");
  const unattested = approvedDelivered("wc_6", { attestations: [] });
  assert.equal(currentApprovalFor(unattested, "rev-1"), null, "an approval without its attestation does not close");
});

test("the verify control renders only for the reviewer holding a current approval", () => {
  assert.match(render([approvedDelivered("wc_7")], reviewer), /data-claim-action="verify"/);
  assert.doesNotMatch(render([approvedDelivered("wc_7", { reviews: [], attestations: [] })], reviewer), /data-claim-action="verify"/,
    "no approval yet: the act is the review, not the verify");
  const stale = approvedDelivered("wc_7", { delivery: deliveredBundle("b".repeat(64)), deliveryGeneration: 2 });
  assert.doesNotMatch(render([stale], reviewer), /data-claim-action="verify"/, "a stale approval earns no verify control");
});

// --- the holder's finish honours the review policy ---

test("under a reviewed policy the holder finishes to delivered, not done", () => {
  const reviewed = render([claim("wc_8", { reviewPolicy: "distinct_member" })], worker);
  assert.match(reviewed, /data-claim-deliver="wc_8"/, "the finish is the deliver form — a bare button could not carry the bundle");
  assert.doesNotMatch(reviewed, /data-claim-action="done"/, "done would be refused work_not_delivered");
  const roomPolicy = render([claim("wc_8")], worker, { reviewPolicy: "independent_principal" });
  assert.match(roomPolicy, /data-claim-deliver="wc_8"/, "the room default policy drives the same choice");
  const selfAttested = render([claim("wc_8")], worker);
  assert.match(selfAttested, /data-claim-action="done"/, "self-attested keeps the single-step finish");
  assert.doesNotMatch(selfAttested, /data-claim-deliver/);
});

// --- what-needs-me sees delivered reviews owed ---

test("needs-me lists a delivered claim tagged for my review", () => {
  const item = claim("wc_9", { state: "delivered", tags: ["rev-rev-1"] });
  const html = needsMeHtml([item], reviewer, members, NOW);
  assert.match(html, /data-needs-me-open="wc_9"/, "the delivered review I owe is surfaced with its jump button");
});
