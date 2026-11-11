// T2-L04a-C5: the claim-PR poll must verify that a GitHub response body is
// the pull it asked for before settling on it. A body for a different pull
// number or a different repository must be refused (reported as an error,
// never as merged/closed), while a body whose identity fields match the
// requested pull settles exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import { collectPullRequestLookups, commitPullRequestLookup } from "../server/claim-pr-sync.mjs";
import { createWorkClaimRegistry } from "../server/work-claim-routes.mjs";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const PR_URL = "https://github.com/o/r/pull/1";
const PULL = { url: PR_URL, repo: "o/r", number: 1 };

function respond(body) {
  return {
    status: 200, ok: true, headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

function bodyFor(number, repo = "o/r", extra = {}) {
  return {
    number,
    state: "closed",
    merged: true,
    html_url: `https://github.com/${repo}/pull/${number}`,
    url: `https://api.github.com/repos/${repo}/pulls/${number}`,
    base: { repo: { full_name: repo } },
    head: { sha: "a".repeat(40) },
    merge_commit_sha: "b".repeat(40),
    ...extra
  };
}

const item = () => ({ roomId: "r1", id: "cl1", state: "in_progress", pullRequest: PULL, pullRequests: [PULL] });

async function lookup(body) {
  const batch = await collectPullRequestLookups([item()], {
    fetchImpl: async () => respond(body), token: "t", nowMs: NOW
  });
  assert.equal(batch.results.length, 1);
  return batch.results[0];
}

test("a merged body for a different pull number does not settle the claim", async () => {
  const result = await lookup(bodyFor(999));
  assert.equal(result.claimId, "cl1");
  assert.notEqual(result.kind, "merged", "PR #999's outcome must not settle PR #1's claim");
  assert.equal(result.kind, "error");
});

test("a merged body for a different repository does not settle the claim", async () => {
  const result = await lookup(bodyFor(1, "other/repo"));
  assert.notEqual(result.kind, "merged", "another repo's PR #1 must not settle this claim");
  assert.equal(result.kind, "error");
});

test("a closed body whose html_url names a different pull does not settle the claim", async () => {
  const result = await lookup(bodyFor(1, "o/r", {
    merged: false,
    html_url: "https://github.com/o/r/pull/999"
  }));
  assert.notEqual(result.kind, "closed");
  assert.equal(result.kind, "error");
});

test("a body whose api url names a different repository does not settle the claim", async () => {
  const result = await lookup(bodyFor(1, "o/r", {
    url: "https://api.github.com/repos/other/repo/pulls/1"
  }));
  assert.equal(result.kind, "error");
});

test("a merged body matching the requested pull still settles", async () => {
  const result = await lookup(bodyFor(1));
  assert.equal(result.kind, "merged");
  assert.equal(result.mergedSha, "b".repeat(40));
});

test("an open body matching the requested pull is still read as open", async () => {
  const result = await lookup(bodyFor(1, "o/r", {
    state: "open", merged: false, head: { sha: "not-a-sha" }, merge_commit_sha: null
  }));
  assert.equal(result.kind, "open");
});

test("end to end: a mismatched merged body leaves the claim unsettled after commit", async () => {
  const registry = createWorkClaimRegistry();
  let claim = claimWork(createWork({ id: "cl1" }, { now: NOW, agentId: "alice" }),
    "alice", { now: NOW, leaseHours: null });
  claim = appendWorkPullRequest(claim, "alice", {
    pullRequest: PR_URL, expectedClaimedAt: claim.claimedAt,
    expectedHistoryLength: claimHistoryLength(claim), now: NOW
  });
  registry.set("r1", claim);

  const result = await lookup(bodyFor(999));
  const settled = commitPullRequestLookup({}, registry, "r1", registry.get("r1", "cl1"), result, NOW);
  assert.equal(settled, false);
  assert.notEqual(registry.get("r1", "cl1").state, "done", "the claim must not be settled by PR #999");
  assert.equal(registry.get("r1", "cl1").pullRequest.outcome ?? null, null);
});
