// B4-BOARD-BATCH PR-B: B7 handoff H1 (send-back control) + H5
// (criteria-bearing self-attested finish) and the board sweep Mediums
// #3885 (verify offered without the verify permission), #3887
// (self-attested delivered claim cannot complete), #3889 (identical
// re-review after the basis moved silently records nothing).
import test from "node:test";
import assert from "node:assert/strict";
import { boardHtml, canSendBackClaim, canVerifyFromBoard, claimSendBackBody, claimReviewBody,
  reviewOutcomeConfirmed, claimDeliverBody } from "../src/board-ui.js";
import { createWork, claimWork, updateWork, recordReview, recordCi } from "../server/work-claims.mjs";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const T0 = "2026-10-18T10:00:00.000Z";
const SHA = "a".repeat(64);
const DIGEST = "d".repeat(64);
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const members = {
  "agent-1": { id: "agent-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-1": { id: "rev-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  "rev-v": { id: "rev-v", kind: "human", active: true, permissions: ["accept_work", "complete_work", "verify"] },
  "mgr-1": { id: "mgr-1", kind: "human", active: true, permissions: ["manage_claims"] },
  "other-1": { id: "other-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
};
const worker = { id: "agent-1", manage: false, owner: false, write: true };
const reviewer = { id: "rev-1", manage: false, owner: false, write: true };
const verifier = { id: "rev-v", manage: false, owner: false, write: true };
const manager = { id: "mgr-1", manage: true, owner: false, write: true };
const other = { id: "other-1", manage: false, owner: false, write: true };

const basis = (extra = {}) => ({ version: 1, owner: "agent-1", claimedAt: T0, revision: null,
  headSha: null, deliveryDigest: DIGEST, deliveryGeneration: 1, ...extra });
const delivery = { artifact: { kind: "report", ref: "https://example.com/r", sha256: SHA },
  checks: [{ name: "unit", result: "pass" }], criteria: [], digest: DIGEST, deliveredBy: "agent-1", deliveredAt: T0 };
const claim = (id, extra = {}) => ({
  id, title: `Title ${id}`, state: "delivered", owner: "agent-1", kind: "task",
  files: [], dependsOn: [], tags: [], reviews: [], attestations: [], history: [],
  claimedAt: T0, delivery, deliveryGeneration: 1, ...extra,
});
const render = (items, viewer, opts = {}) => boardHtml(items, null, viewer, members, NOW, opts);
const changesRequested = (memberId = "rev-1", extra = {}) => ({
  memberId, verdict: "changes_requested", summary: "please fix", at: "2026-10-18T11:00:00.000Z", basis: basis(), ...extra,
});
const approval = (memberId = "rev-1") => ({
  memberId, verdict: "approve", summary: "looks right", at: "2026-10-18T11:00:00.000Z", basis: basis(),
});

// --- H1 / #3888: the send-back control ---

test("H1: a current changes_requested review earns the reviewer and a manager a send-back control", () => {
  const item = claim("wc_sb", { reviews: [changesRequested()] });
  assert.match(render([item], reviewer), /data-claim-action="sendback"/, "the changes_requested reviewer can send it back");
  assert.match(render([item], manager), /data-claim-action="sendback"/, "a claim manager can send it back");
  assert.equal(canSendBackClaim(item, reviewer, members), true);
  assert.equal(canSendBackClaim(item, manager, members), true);
});

test("H1: the owner can always send back their own delivered claim; unrelated members cannot", () => {
  const item = claim("wc_sb2");
  assert.match(render([item], worker), /data-claim-action="sendback"/, "the owner needs no review to resume their work");
  assert.doesNotMatch(render([claim("wc_sb2", { reviews: [changesRequested()] })], other), /data-claim-action="sendback"/,
    "a member who is neither owner, manager, nor the changes_requested reviewer gets no control");
  const stale = claim("wc_sb3", { reviews: [changesRequested("rev-1", { basis: basis({ deliveryDigest: "b".repeat(64) }) })] });
  assert.doesNotMatch(render([stale], reviewer), /data-claim-action="sendback"/,
    "a stale changes_requested review (basis moved) earns no control");
  assert.doesNotMatch(render([claim("wc_sb4", { state: "in_progress", reviews: [changesRequested()] })], reviewer),
    /data-claim-action="sendback"/, "only delivered claims can be sent back");
});

test("H1: claimSendBackBody posts the transition with operation identity and round basis", () => {
  const item = claim("wc_sb5", { history: [{ action: "claimed" }, { action: "state:delivered" }], historyOmitted: 1 });
  const body = claimSendBackBody(item, "rev-1");
  assert.equal(body.state, "in_progress");
  assert.match(body.requestId, /^sendback-wc_sb5-1-rev-1$/);
  assert.equal(body.expectedClaimedAt, T0);
  assert.equal(body.expectedHistoryLength, 3);
  // Kernel composition: the body drives the real transition for the
  // authorized reviewer (the route supplies authority for this gate).
  let work = createWork({ id: "wc_sb5", reviewPolicy: "distinct_member" }, { agentId: "agent-1" });
  work = updateWork(claimWork(work, "agent-1"), "agent-1", { state: "in_progress" });
  work = updateWork(work, "agent-1", { state: "delivered",
    delivery: { artifact: { kind: "report", ref: "https://example.com/r", sha256: SHA },
      checks: [{ name: "unit", result: "pass" }], criteria: [] } });
  work = recordReview(work, "rev-1", { verdict: "changes_requested", summary: "please fix" });
  const sent = updateWork(work, "rev-1", { state: body.state, requestId: body.requestId, authority: true });
  assert.equal(sent.state, "in_progress");
  assert.equal(sent.verification.state, "changes_requested");
  assert.equal(sent.verification.by, "rev-1");
});

// --- H5 / #3886: criteria-bearing self-attested finish ---

test("H5: under self_attested a criteria-bearing claim gets the deliver form, not the refused bare Done", () => {
  const item = claim("wc_h5", { state: "in_progress", reviewPolicy: "self_attested",
    acceptanceCriteria: ["tests green"], delivery: null, deliveryGeneration: 0 });
  const html = render([item], worker);
  assert.match(html, /data-claim-deliver="wc_h5"/, "the bundle-carrying form is the finish");
  assert.doesNotMatch(html, /data-claim-action="done"/, "bare Done would be refused delivery_incomplete");
  const plain = claim("wc_h5b", { state: "in_progress", reviewPolicy: "self_attested", delivery: null, deliveryGeneration: 0 });
  const plainHtml = render([plain], worker);
  assert.match(plainHtml, /data-claim-action="done"/, "criteria-free self-attested claims keep the one-step Done");
  assert.doesNotMatch(plainHtml, /data-claim-deliver/, "…and gain no form");
});

test("H5+#3887 journey: deliver form -> delivered -> owner verify completes a criteria-bearing self-attested claim", () => {
  let work = createWork({ id: "wc_j", reviewPolicy: "self_attested",
    acceptanceCriteria: ["tests green"] }, { agentId: "agent-1" });
  work = updateWork(claimWork(work, "agent-1"), "agent-1", { state: "in_progress" });
  const form = new FormData();
  form.set("artifactKind", "report"); form.set("artifactRef", "https://example.com/j");
  form.set("artifactSha256", SHA); form.append("checkName", "unit"); form.append("checkResult", "pass");
  form.append("criterion", "met");
  const body = claimDeliverBody(work, form, "agent-1");
  work = updateWork(work, "agent-1", body);
  assert.equal(work.state, "delivered");
  assert.equal(canVerifyFromBoard(work, worker, members), true, "the owner is offered the closing verify");
  work = updateWork(work, "agent-1", { state: "done" });
  assert.equal(work.state, "done");
  assert.equal(work.verification.state, "self_attested");
});

// --- #3887: owner-verify on a delivered self-attested claim ---

test("#3887: a delivered self-attested claim offers Verify to its owner and to nobody else", () => {
  const item = claim("wc_387", { reviewPolicy: "self_attested" });
  assert.match(render([item], worker), /data-claim-action="verify"/, "the owner can complete their delivered claim");
  assert.doesNotMatch(render([item], reviewer), /data-claim-action="verify"/,
    "a non-owner is not offered a verify the kernel would refuse under self_attested");
  assert.equal(canVerifyFromBoard(item, worker, members), true);
  assert.equal(canVerifyFromBoard(item, reviewer, members), false);
});

// --- #3885: verify under independent_principal requires the verify permission ---

test("#3885: an approver without the verify permission is not offered Verify under independent_principal", () => {
  const item = claim("wc_385", { reviewPolicy: "independent_principal",
    reviews: [approval("rev-1")], attestations: [{ memberId: "rev-1", at: "2026-10-18T11:00:00.000Z", note: "looks right" }] });
  assert.doesNotMatch(render([item], reviewer), /data-claim-action="verify"/,
    "rev-1 approved but lacks the verify permission — no control");
  assert.equal(canVerifyFromBoard(item, reviewer, members), false);
  const withVerify = claim("wc_385", { reviewPolicy: "independent_principal",
    reviews: [approval("rev-v")], attestations: [{ memberId: "rev-v", at: "2026-10-18T11:00:00.000Z", note: "looks right" }] });
  assert.match(render([withVerify], verifier), /data-claim-action="verify"/,
    "the approver holding the verify permission is offered Verify");
  const distinct = claim("wc_385", { reviewPolicy: "distinct_member",
    reviews: [approval("rev-1")], attestations: [{ memberId: "rev-1", at: "2026-10-18T11:00:00.000Z", note: "looks right" }] });
  assert.match(render([distinct], reviewer), /data-claim-action="verify"/,
    "distinct_member does not require the verify permission");
});

// --- #3889: identical re-review after the basis moved ---

test("#3889: the review body names the basis read, and the kernel refreshes a sole head move only when it is named", () => {
  let work = createWork({ id: "wc_389", reviewPolicy: "distinct_member" }, { agentId: "agent-1" });
  work = updateWork(claimWork(work, "agent-1"), "agent-1", { state: "in_progress" });
  work = recordCi(work, { state: "success", headSha: HEAD_A }).item;
  work = recordReview(work, "rev-1", { verdict: "approve", summary: "LGTM" });
  assert.equal(work.reviews[0].basis.headSha, HEAD_A);
  work = recordCi(work, { state: "success", headSha: HEAD_B }).item;
  // The silent no-op the board used to announce as "Reviewed": identical
  // content, no basis named, basis stale — nothing is recorded.
  const noop = recordReview(work, "rev-1", { verdict: "approve", summary: "LGTM" });
  assert.equal(noop.history.length, work.history.length, "the unnamed identical re-review records nothing");
  assert.equal(noop.reviews[0].basis.headSha, HEAD_A, "the stale approval stands");
  assert.equal(reviewOutcomeConfirmed(noop, "rev-1", "approve", "LGTM"), false,
    "the board's readback refuses to call that a recorded review");
  // Naming the basis the reviewer actually read makes it deliberate.
  const body = claimReviewBody(work, "approve", "LGTM");
  assert.equal(body.expectedBasis.headSha, HEAD_B);
  assert.equal(body.expectedBasis.owner, "agent-1");
  const refreshed = recordReview(work, "rev-1", body);
  assert.equal(refreshed.reviews[0].basis.headSha, HEAD_B, "the approval now binds the new head");
  assert.equal(reviewOutcomeConfirmed(refreshed, "rev-1", "approve", "LGTM"), true,
    "…and the readback confirms it");
});
