// Board UI: the VERIFY step of the CLAIM → COMPLETE → VERIFY journey.
// Before this fix the board rendered Claim / Mark in progress / Link PR / Done
// but no way to record a review: the "What needs me › Review" button only
// scrolled to the card, and the POST /work-claims/:id/review route was
// reachable only via API/MCP. canReviewClaim mirrors the server's
// mayReviewWorkClaims gate; claimReviewForm renders the review controls.
import test from "node:test";
import assert from "node:assert/strict";
import { canReviewClaim, claimReviewForm } from "../src/board-ui.js";

const item = (id, extra = {}) => ({
  id,
  title: id,
  state: "claimed",
  owner: "owner-1",
  ...extra,
});
const viewer = (id, extra = {}) => ({ id, manage: false, owner: false, write: true, ...extra });
const members = (extra = {}) => ({
  "owner-1": { id: "owner-1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  "reviewer-1": { id: "reviewer-1", kind: "human", active: true, permissions: ["accept_work", "complete_work"] },
  "verifier-1": { id: "verifier-1", kind: "human", active: true, permissions: ["verify"] },
  "stranger-1": { id: "stranger-1", kind: "human", active: true, permissions: [] },
  ...extra,
});

// --- canReviewClaim: who may record a verdict review from the board ---

test("canReviewClaim lets a non-owner with write rights review an open claim", () => {
  assert.equal(canReviewClaim(item("a"), viewer("reviewer-1"), members()), true);
});

test("canReviewClaim lets a verify-permission holder without write rights review", () => {
  assert.equal(canReviewClaim(item("a"), viewer("verifier-1", { write: false }), members()), true);
});

test("canReviewClaim refuses the owner reviewing their own claim", () => {
  assert.equal(canReviewClaim(item("a"), viewer("owner-1"), members()), false);
});

test("canReviewClaim refuses signed-out viewers and unknown/inactive members", () => {
  assert.equal(canReviewClaim(item("a"), viewer(null), members()), false);
  assert.equal(canReviewClaim(item("a"), { id: "ghost-9", write: true }, members()), false);
  const inactive = members({ "reviewer-1": { id: "reviewer-1", kind: "human", active: false, permissions: ["accept_work"] } });
  assert.equal(canReviewClaim(item("a"), viewer("reviewer-1"), inactive), false);
});

test("canReviewClaim refuses members with neither write rights nor the verify permission", () => {
  assert.equal(canReviewClaim(item("a"), viewer("stranger-1", { write: false }), members()), false);
});

test("canReviewClaim refuses unclaimed, done, and closed claims", () => {
  const v = viewer("reviewer-1"), m = members();
  assert.equal(canReviewClaim(item("a", { state: "unclaimed", owner: null }), v, m), false);
  assert.equal(canReviewClaim(item("a", { state: "done" }), v, m), false);
  assert.equal(canReviewClaim(item("a", { state: "closed" }), v, m), false);
});

test("canReviewClaim allows review while the work is in progress, blocked, or has an open PR", () => {
  const v = viewer("reviewer-1"), m = members();
  assert.equal(canReviewClaim(item("a", { state: "in_progress" }), v, m), true);
  assert.equal(canReviewClaim(item("a", { state: "blocked" }), v, m), true);
  assert.equal(
    canReviewClaim(item("a", { pullRequest: { url: "https://github.com/o/r/pull/1" } }), v, m),
    true
  );
  // An open PR does not make a finished claim reviewable: the server's
  // recordReview only accepts active claims, so the form would always 4xx.
  for (const state of ["done", "cancelled", "closed", "unclaimed"]) {
    assert.equal(
      canReviewClaim(item("a", { state, pullRequest: { url: "https://github.com/o/r/pull/1" } }), v, m),
      false, state
    );
  }
});

// --- claimReviewForm: the review controls on the claim card ---

test("claimReviewForm renders a verdict review form bound to the claim id", () => {
  const html = claimReviewForm(item("claim-1"));
  assert.match(html, /<form[^>]*data-claim-review="claim-1"/);
  assert.match(html, /<select[^>]*name="verdict"[^>]*required/);
  assert.match(html, /<option value="approve"/);
  assert.match(html, /<option value="changes_requested"/);
  assert.match(html, /<option value="comment"/);
  assert.match(html, /<input[^>]*name="summary"[^>]*required/);
  assert.match(html, /type="submit"/);
});

test("claimReviewForm carries no hardcoded English: labels come from the strings catalog", () => {
  const html = claimReviewForm(item("claim-1"));
  const text = html.replace(/<[^>]*>/g, " ");
  for (const phrase of ["Review this work", "Verdict", "Request changes", "Submit review"]) {
    assert.ok(text.includes(phrase), `form should render catalog copy: ${phrase}`);
  }
});

test("claimReviewForm escapes the claim id", () => {
  const html = claimReviewForm(item('"><script>alert(1)</script>'));
  assert.ok(!html.includes("<script>"), "raw script tag leaked into form HTML");
  assert.match(html, /data-claim-review="&quot;&gt;&lt;script&gt;/);
});
