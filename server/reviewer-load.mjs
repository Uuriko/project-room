// Reviewer load (#3755): per-reviewer pending-review depth, derived at
// read time from the claim board's existing review state. No persisted
// counters: a claim is "pending review" for a reviewer when it is ready
// to review and that reviewer has not already reviewed its current basis.
//
// Ready to review mirrors the two existing definitions of that state:
//   - "delivered" — the owner has submitted the work for review (the
//     finish transition in server/work-claim-routes.mjs), or
//   - "in_progress" with a linked pull request — the readiness rule
//     needs-me's reviewAsksOf already uses for named-reviewer asks.
// Terminal claims, superseded claims, and claims with no owner wait on
// nobody. Excluded per reviewer: the claim's owner (nobody reviews their
// own work) and anyone holding a current-basis review (hasCurrentReview).
//
// Who a claim waits on: its resolved named reviewers (rev-<memberId>
// tags, resolved against the room's active members) when it names any;
// otherwise every eligible reviewer the caller supplies (the room's
// review-eligible member ids, from work-claim-routes reviewersOf). An
// unnamed claim counts toward every eligible reviewer's depth because
// any of them may pick it up — that shared depth is exactly the pile-on
// the depth surface exists to make visible.

import { hasCurrentReview, isTerminalClaimState, resolveNamedReviewers } from "./work-claims.mjs";

export function isPendingReview(item) {
  if (!item || item.supersededBy || !item.owner) return false;
  if (isTerminalClaimState(item.state)) return false;
  if (item.state === "delivered") return true;
  return item.state === "in_progress" && Boolean(item.pullRequest || (item.pullRequests ?? []).length);
}

// The reviewers a single claim is currently waiting on, given the room's
// members (for named-reviewer resolution) and its eligible reviewer ids.
export function pendingReviewersFor(item, members = {}, eligibleReviewers = []) {
  if (!isPendingReview(item)) return [];
  const named = resolveNamedReviewers(item, members);
  const candidates = named.length ? named : eligibleReviewers;
  return [...new Set(candidates)].filter(memberId =>
    typeof memberId === "string" && memberId && memberId !== item.owner && !hasCurrentReview(item, memberId));
}

// Per-reviewer pending-review depth for one room's board. Every eligible
// reviewer appears, including at depth 0 — a less-loaded reviewer is only
// visible if the surface shows the zeros. Reviewers named on a claim but
// absent from the eligible list also appear once they carry depth, so a
// named ask is never invisible. Sorted deepest first, then memberId, so
// the ordering is stable and the least loaded sort last.
export function reviewerLoadOf(items, members = {}, eligibleReviewers = []) {
  const byReviewer = new Map();
  const ensure = memberId => {
    if (!byReviewer.has(memberId)) byReviewer.set(memberId, { memberId, pendingReviews: 0, claimIds: [] });
    return byReviewer.get(memberId);
  };
  for (const memberId of eligibleReviewers) {
    if (typeof memberId === "string" && memberId) ensure(memberId);
  }
  for (const item of items ?? []) {
    for (const memberId of pendingReviewersFor(item, members, eligibleReviewers)) {
      const row = ensure(memberId);
      row.pendingReviews += 1;
      row.claimIds.push(item.id);
    }
  }
  return [...byReviewer.values()].sort((a, b) =>
    b.pendingReviews - a.pendingReviews || String(a.memberId).localeCompare(String(b.memberId)));
}

// The less-loaded offering for one claim about to be (or just) submitted
// for review: the eligible reviewers for THIS claim, least loaded first.
// Presentation only — the caller decides whether to show or default to
// the head of the list; nothing here assigns, wakes, or narrows who may
// review. `depth` maps every candidate to their pending count including
// the claim itself when it already reads as pending (e.g. just
// delivered). Returns null when the claim has no eligible reviewer.
export function reviewerOfferFor(item, items, members = {}, eligibleReviewers = []) {
  const candidates = pendingReviewersFor(item, members, eligibleReviewers);
  if (!candidates.length) return null;
  const load = new Map(reviewerLoadOf(items, members, eligibleReviewers)
    .map(row => [row.memberId, row.pendingReviews]));
  const ranked = candidates
    .map(memberId => ({ memberId, pendingReviews: load.get(memberId) ?? 0 }))
    .sort((a, b) => a.pendingReviews - b.pendingReviews || String(a.memberId).localeCompare(String(b.memberId)));
  return { suggestedReviewer: ranked[0].memberId, reviewers: ranked };
}
