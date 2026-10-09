// Regression tests pinning three mutation-testing gaps (wave1000 guild-01).
// Each test passes on correct code and fails against the corresponding
// mutant: M4 (release keeps attestations), M6 (stale-outcome tie-break
// backstop dropped), M7 (stale review basis accepted by canCloseWork).
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork, appendWorkPullRequest, attestWork,
  recordReview, recordCi, canCloseWork, claimHistoryLength,
} from "../server/work-claims.mjs";

const T0 = 1_789_000_000_000;
const PR = "https://github.com/acme/repo/pull/7";

test("M4-gap: release clears the lapsed owner's attestations and reviews", () => {
  let w = claimWork(createWork({ id: "g-m4" }), "A", { now: T0 });
  w = updateWork(w, "A", { state: "in_progress", now: T0 + 1 });
  w = attestWork(w, "B", { note: "looks fine", now: T0 + 2 });
  w = recordReview(w, "C", { verdict: "comment", summary: "a comment", now: T0 + 3 });
  assert.equal(w.attestations.length, 1);
  assert.equal(w.reviews.length, 1);
  const paused = updateWork(w, "A", { state: "claimed", now: T0 + 4 });
  const released = updateWork(paused, "A", { state: "unclaimed", now: T0 + 5 });
  assert.equal(released.state, "unclaimed");
  assert.deepEqual(released.attestations, [], "released claim must not leak attestations to the next owner");
  assert.deepEqual(released.reviews, [], "released claim must not leak reviews to the next owner");
});

test("M6-gap: stale-outcome tie uses the two-claimed-stamps backstop", () => {
  // Simulate a trimmed history: two "claimed" stamps (two rounds) whose
  // round-ending stamp aged out of the 200-entry window — exactly the case
  // the backstop exists for (see the appendWorkPullRequest comment).
  let w = claimWork(createWork({ id: "g-m6" }), "A", { now: T0 });
  w = appendWorkPullRequest(w, "A", { pullRequest: PR,
    expectedClaimedAt: w.claimedAt, expectedHistoryLength: claimHistoryLength(w), now: T0 + 1 });
  const claimedAgain = { at: new Date(T0 + 2).toISOString(), agentId: "A", action: "claimed", note: null };
  const trimmed = { ...w,
    history: Object.freeze([...w.history, claimedAgain]),
    // The recorded outcome's timestamp ties the current round's claimedAt.
    pullRequests: Object.freeze(w.pullRequests.map(pull =>
      pull.url === PR ? { ...pull, outcome: "merged", syncedAt: w.claimedAt } : pull)),
  };
  assert.ok(!trimmed.history.some(entry =>
    ["pr_closed", "pr_merged", "state:unclaimed", "lease_expired"].includes(entry.action)),
    "control: no round-ending stamp — only the backstop can prove the prior round");
  const relinked = appendWorkPullRequest(trimmed, "A", { pullRequest: PR,
    expectedClaimedAt: trimmed.claimedAt, expectedHistoryLength: claimHistoryLength(trimmed), now: T0 + 3 });
  const link = relinked.pullRequests.find(pull => pull.url === PR);
  assert.equal(link.outcome ?? null, null,
    "tied outcome with two claimed stamps must reset the link (stale), not no-op");
});

test("M7-gap: canCloseWork rejects a review on a stale basis", () => {
  let w = claimWork(createWork({ id: "g-m7", reviewPolicy: "distinct_member" }), "A", { now: T0 });
  w = updateWork(w, "A", { state: "in_progress", now: T0 + 1 });
  w = recordReview(w, "B", { verdict: "approve", summary: "lgtm", now: T0 + 2 });
  const members = { reviewMembers: new Set(["B"]) };
  assert.equal(canCloseWork(w, "B", { policy: "distinct_member", ...members }), true,
    "control: current approve closes");
  // A new CI head changes the review basis (owner/claimedAt/revision/headSha);
  // the recorded approve is now stale and must not close the work.
  const rolled = recordCi(w, { state: "success", headSha: "a".repeat(40),
    checkedAt: new Date(T0 + 3).toISOString() }, T0 + 3);
  assert.equal(canCloseWork(rolled.item, "B", { policy: "distinct_member", ...members }), false,
    "stale-basis approve must not close the work");
});
