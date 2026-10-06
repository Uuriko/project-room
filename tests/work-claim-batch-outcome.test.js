// Zero-bug wave fix lane: GitHub issue #1518 (HIGH).
//
// batchPullOutcome() was all-or-nothing over every recorded PR link, so one
// stale pr_closed link vetoed a genuinely merged PR — the worker lost done
// credit for work that actually merged. A merged link is authoritative
// evidence of done: ANY "merged" link must yield "merged".
//
// Adapted from QA WAVE Lane QA-b evidence (qa-b-settlement-b1.test.js),
// which reproduced this on main via the real commitPullRequestLookup path.
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordPullOutcome, pullsReadyToSettle, batchPullOutcome, settlePullRequest,
} from "../server/claim-coordination.mjs";
import {
  createWork, claimWork, appendWorkPullRequest, claimHistoryLength,
} from "../server/work-claims.mjs";
import { commitPullRequestLookup } from "../server/claim-pr-sync.mjs";
import { createWorkClaimRegistry } from "../server/work-claim-routes.mjs";

const PR1 = "https://github.com/Uuriko/project-room/pull/1500";
const PR2 = "https://github.com/Uuriko/project-room/pull/1501";
const ROOM = "batch-outcome-room";
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function linkPr(item, agent, url, nowMs) {
  return appendWorkPullRequest(item, agent, {
    pullRequest: url,
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item),
    now: nowMs,
  });
}

test("batchPullOutcome: a stale closed link cannot veto a merged link", () => {
  const item = {
    pullRequests: [
      Object.freeze({ url: PR1, outcome: "closed", syncedAt: "2026-10-05T11:00:00.000Z" }),
      Object.freeze({ url: PR2, outcome: "merged", syncedAt: "2026-10-05T12:00:00.000Z" }),
    ],
  };
  assert.equal(batchPullOutcome(item), "merged",
    "a merged link is authoritative evidence of done; a stale closed link must not veto it");
});

test("batchPullOutcome: all links closed still settles as closed", () => {
  const item = {
    pullRequests: [
      Object.freeze({ url: PR1, outcome: "closed", syncedAt: "2026-10-05T11:00:00.000Z" }),
      Object.freeze({ url: PR2, outcome: "closed", syncedAt: "2026-10-05T12:00:00.000Z" }),
    ],
  };
  assert.equal(batchPullOutcome(item), "closed");
});

test("batchPullOutcome: all links merged still settles as merged", () => {
  const item = {
    pullRequests: [
      Object.freeze({ url: PR1, outcome: "merged", syncedAt: "2026-10-05T11:00:00.000Z" }),
    ],
  };
  assert.equal(batchPullOutcome(item), "merged");
});

test("round-2 merged PR settles as pr_merged even with a stale round-1 closed PR", () => {
  // Round 1: claim, link PR1, PR1 closes unmerged -> pr_closed settlement.
  let item = claimWork(createWork({ id: "batch-claim" }, { now: NOW, agentId: "alice" }), "alice", { now: NOW });
  item = linkPr(item, "alice", PR1, NOW);
  const r1 = recordPullOutcome(item, PR1, "closed", NOW);
  assert.equal(pullsReadyToSettle(r1), true);
  const settled1 = settlePullRequest(r1, batchPullOutcome(r1), NOW);
  assert.equal(settled1.action, "pr_closed");
  assert.equal(settled1.item.state, "unclaimed");

  // Round 2: re-claim (inherits the settled PR1 link), link PR2, PR2 merges.
  let round2 = claimWork(settled1.item, "alice", { now: NOW + 1000 });
  round2 = linkPr(round2, "alice", PR2, NOW + 1000);
  assert.deepEqual(
    round2.pullRequests.map(p => [p.url, p.outcome ?? null]),
    [[PR1, "closed"], [PR2, null]],
    "round 2 inherits the already-settled round-1 link"
  );

  // Drive the REAL settlement path the cron and the sweep both call.
  const registry = createWorkClaimRegistry();
  registry.set(ROOM, round2);
  const current = registry.get(ROOM, "batch-claim");
  const settled = commitPullRequestLookup({}, registry, ROOM, current,
    { claimId: "batch-claim", url: PR2, kind: "merged" }, NOW + 2000);
  assert.equal(settled, true, "the lookup settled the claim");
  const final = registry.get(ROOM, "batch-claim");

  assert.equal(final.state, "done",
    `round-2's merged PR settled as a release (state=${final.state}); the delivered work earns no done credit`);
  assert.equal(final.pullRequest.outcome, "merged",
    "settled record must not contradict itself (action pr_closed with pullRequest.outcome merged)");
});
