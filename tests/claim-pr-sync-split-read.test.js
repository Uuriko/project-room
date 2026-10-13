// Split CI read (#2841): one tick's request budget can run out between the
// combined-status read and the check-runs read. readCommitCi returns the
// fetched status with cursor "checks", but collectPullRequestLookups used
// to copy only the cursor and commitPullRequestLookup persisted only the
// cursor, so the resumed tick rolled up the check runs alone — a failing
// legacy commit status vanished behind green check runs. The status digest
// now rides with the cursor until the read completes.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry } from "../server/work-claim-routes.mjs";
import { collectPullRequestLookups, commitPullRequestLookup } from "../server/claim-pr-sync.mjs";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength, stampClaimHistory } from "../server/work-claims.mjs";

const ROOM = "split-read-room";
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const SHA = "c".repeat(40);
const PR_URL = "https://github.com/Uuriko/project-room/pull/1600";
const STATUS_URL = "https://ci.example/build/1";

// A failing legacy commit status; the check runs are all green. Only the
// status leg can turn the rollup red.
const STATUS_BODY = {
  state: "failure",
  total_count: 1,
  statuses: [{ context: "legacy/ci", state: "failure", target_url: STATUS_URL }]
};
const CHECK_RUNS_BODY = {
  total_count: 1,
  check_runs: [{ status: "completed", conclusion: "success", html_url: "https://ci.example/run/1" }]
};

function respond(body) {
  return {
    status: 200, ok: true, headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

// A fetch double that serves only the routes a leg is expected to call and
// records every call, so an unexpected read fails the assertions below.
function scriptedFetch(routes, calls) {
  return async url => {
    calls.push(url);
    for (const [match, body] of routes) if (url.includes(match)) return respond(body);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function seededRegistry() {
  const registry = createWorkClaimRegistry();
  let item = claimWork(createWork({ id: "split-1" }, { now: NOW, agentId: "alice" }),
    "alice", { now: NOW, leaseHours: null });
  item = appendWorkPullRequest(item, "alice", {
    pullRequest: PR_URL, expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item), now: NOW
  });
  // A completed read of this same head from an earlier poll, so the split
  // read's resume is a continuation rather than a fresh lookup.
  item = { ...item, ci: { state: "success", url: PR_URL, headSha: SHA, checkedAt: new Date(NOW).toISOString() } };
  registry.set(ROOM, item);
  return registry;
}

test("a CI read split by the budget keeps the combined status for the resume", async () => {
  const registry = seededRegistry();

  // Tick 1: budget for exactly the pull lookup and the status read.
  const calls1 = [];
  const fetch1 = scriptedFetch([
    ["/pulls/1600", { state: "open", merged: false, head: { sha: SHA } }],
    [`/commits/${SHA}/status`, STATUS_BODY],
    [`/commits/${SHA}/check-runs`, CHECK_RUNS_BODY]
  ], calls1);
  const item1 = { ...registry.get(ROOM, "split-1"), roomId: ROOM };
  const batch1 = await collectPullRequestLookups([item1], { fetchImpl: fetch1, token: "t", nowMs: NOW, limit: 2 });
  assert.equal(calls1.length, 2, "the budget stopped the tick before the check-runs read");
  assert.ok(calls1[1].endsWith("/status"), "the second call was the combined status");
  assert.equal(batch1.results.length, 1);
  const result1 = batch1.results[0];
  assert.equal(result1.ciCursor, "checks");
  assert.equal(result1.ci, undefined, "the read is unfinished, so no rollup yet");
  assert.equal(result1.ciStatus?.state, "failure", "the fetched status rides with the cursor");

  commitPullRequestLookup({}, registry, ROOM, registry.get(ROOM, "split-1"), result1, NOW);
  const stored1 = registry.get(ROOM, "split-1");
  assert.equal(stored1.pullRequest.ciCursor, "checks");
  assert.equal(stored1.pullRequest.ciStatus?.state, "failure", "the status digest was persisted with the cursor");
  assert.equal(stored1.pullRequest.ciStatus?.targetUrl, STATUS_URL);

  // Tick 2: the resume reads only the check runs and must still see the
  // failing combined status from tick 1.
  const calls2 = [];
  const fetch2 = scriptedFetch([
    [`/commits/${SHA}/check-runs`, CHECK_RUNS_BODY]
  ], calls2);
  const item2 = { ...registry.get(ROOM, "split-1"), roomId: ROOM };
  const batch2 = await collectPullRequestLookups([item2], { fetchImpl: fetch2, token: "t", nowMs: NOW + 1000 });
  assert.equal(calls2.length, 1, "the resume spent its only call on the check runs");
  assert.ok(calls2[0].endsWith("/check-runs"));
  assert.equal(batch2.results.length, 1);
  const result2 = batch2.results[0];
  assert.equal(result2.ciCursor, "done");
  assert.equal(result2.ci?.state, "failure", "the tick-1 status failure survives the split");
  assert.equal(result2.ci?.url, STATUS_URL, "the rollup link comes from the persisted status");

  commitPullRequestLookup({}, registry, ROOM, registry.get(ROOM, "split-1"), result2, NOW + 1000);
  const stored2 = registry.get(ROOM, "split-1");
  assert.equal(stored2.ci.state, "failure");
  assert.equal(stored2.pullRequest.ciCursor, "done");
  assert.equal(stored2.pullRequest.ciStatus, null, "a completed read clears the persisted digest");
});

test("the persisted status digest survives a claim state-machine write between ticks", () => {
  const registry = seededRegistry();
  const item = registry.get(ROOM, "split-1");
  const split = {
    ...item,
    pullRequest: {
      ...item.pullRequest, ciCursor: "checks",
      ciStatus: { state: "failure", totalCount: 1, targetUrl: STATUS_URL }
    },
    pullRequests: [{
      ...item.pullRequest, ciCursor: "checks",
      ciStatus: { state: "failure", totalCount: 1, targetUrl: STATUS_URL }
    }]
  };
  // stampClaimHistory runs the item through workOf/pullRequestOf, the same
  // normalization any intervening claim write (update, heartbeat, board
  // sweep) applies. The digest must not be dropped there, or the split
  // read's resume would again roll up the check runs alone.
  const normalized = stampClaimHistory(split, "alice", { action: "note", note: "between ticks", now: NOW + 500 });
  assert.equal(normalized.pullRequest.ciCursor, "checks");
  assert.deepEqual(normalized.pullRequest.ciStatus, { state: "failure", totalCount: 1, targetUrl: STATUS_URL });
  assert.deepEqual(normalized.pullRequests[0].ciStatus, { state: "failure", totalCount: 1, targetUrl: STATUS_URL });
});
