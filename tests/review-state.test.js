import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReviewState, routeReviews } from '../scripts/review-state.mjs';

// Authoring gate (test-audit SKILL.md):
// 1. Contracts: (a) a verdict only counts for the exact head it covered — a
//    verdict on a moved head is stale and must not gate a merge; (b) every PR
//    needing review routes to exactly one reviewer lane — no duplicates, no
//    qualifying PR left unassigned, author never self-assigned, prior
//    assignment sticks across head moves so the same lane re-reviews.
// 2. Credible regressions: staleness comparator weakened to prefix/any-sha
//    match; routing re-assigns to a different lane after a rebase; author
//    lands in their own routing slot; a draft or fully-approved PR gets routed.
// 3. No existing coverage: tests/review-state.test.js is new; existing review
//    tests cover work-claim (room-level) reviews, not PR routing.
// 4. No test-only production seams: pure functions over plain fixtures.

const PRS = [
  { number: 101, title: 'feat: widgets', author: 'alice', headSha: 'aaa111', draft: false, additions: 10, deletions: 2, changedFiles: 1 },
  { number: 102, title: 'fix: sprockets', author: 'bob', headSha: 'bbb222', draft: false, additions: 5, deletions: 5, changedFiles: 2 },
  { number: 103, title: 'wip: gadgets', author: 'carol', headSha: 'ccc333', draft: true, additions: 40, deletions: 0, changedFiles: 3 },
];

const LANES = [{ name: 'fo' }, { name: 'instinct' }];

test('APPROVE on a moved head is stale and re-arms review', () => {
  const [st] = analyzeReviewState({
    prs: PRS,
    reviews: [{ prNumber: 101, reviewer: 'fo', verdict: 'APPROVE', headSha: 'old999', at: '2026-10-06T17:00:00Z' }],
  });
  assert.equal(st.reviews[0].stale, true);
  assert.equal(st.verdict.status, 'stale_verdict');
  assert.equal(st.needsReview, true);
});

test('APPROVE on the exact head is fresh and clears review', () => {
  const [st] = analyzeReviewState({
    prs: PRS,
    reviews: [{ prNumber: 101, reviewer: 'fo', verdict: 'APPROVE', headSha: 'aaa111', at: '2026-10-06T17:00:00Z' }],
  });
  assert.equal(st.reviews[0].stale, false);
  assert.equal(st.verdict.status, 'approved_fresh');
  assert.equal(st.needsReview, false);
});

test('CHANGES_REQUESTED on the exact head keeps review armed', () => {
  const [, st] = analyzeReviewState({
    prs: PRS,
    reviews: [{ prNumber: 102, reviewer: 'instinct', verdict: 'CHANGES', headSha: 'bbb222', at: '2026-10-06T17:00:00Z' }],
  });
  assert.equal(st.verdict.status, 'changes_requested');
  assert.equal(st.needsReview, true);
});

test('routing assigns every review-needing non-draft PR to exactly one lane', () => {
  const states = analyzeReviewState({ prs: PRS, reviews: [] });
  const { assignments, unrouted } = routeReviews(states, LANES, {});
  // PRs 101 and 102 need review; 103 is a draft and must not be routed.
  assert.deepEqual(Object.keys(assignments).sort(), ['101', '102']);
  assert.deepEqual(unrouted, []);
  for (const lane of Object.values(assignments)) {
    assert.ok(LANES.some((l) => l.name === lane), `unknown lane ${lane}`);
  }
});

test('routing is deterministic across runs', () => {
  const states = analyzeReviewState({ prs: PRS, reviews: [] });
  const a = routeReviews(states, LANES, {});
  const b = routeReviews(states, LANES, {});
  assert.deepEqual(a, b);
});

test('routing never assigns a lane to its own PR', () => {
  const lanes = [{ name: 'alice' }, { name: 'bob' }];
  const states = analyzeReviewState({ prs: PRS, reviews: [] });
  const { assignments } = routeReviews(states, lanes, {});
  const byNumber = Object.fromEntries(PRS.map((p) => [p.number, p.author]));
  for (const [num, lane] of Object.entries(assignments)) {
    assert.notEqual(lane, byNumber[num], `lane ${lane} self-assigned to PR ${num}`);
  }
});

test('prior assignment sticks across head moves so the same lane re-reviews', () => {
  const states = analyzeReviewState({
    prs: PRS,
    reviews: [{ prNumber: 101, reviewer: 'fo', verdict: 'APPROVE', headSha: 'old999', at: '2026-10-06T17:00:00Z' }],
  });
  const { assignments } = routeReviews(states, LANES, { 101: 'instinct' });
  assert.equal(assignments['101'], 'instinct');
});

test('PR with no eligible lane lands in unrouted, not silently dropped', () => {
  const states = analyzeReviewState({ prs: [PRS[0]], reviews: [] });
  const { assignments, unrouted } = routeReviews(states, [{ name: 'alice' }], {});
  // alice is the author; the only other lane is unavailable, so no assignment.
  assert.deepEqual(assignments, {});
  assert.deepEqual(unrouted, [101]);
});
