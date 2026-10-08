// PR-settlement cron resolves lookup results to rooms.
// Authoring gate: this protects the (roomId, claimId) scoping contract —
// claim ids are room-scoped, so the same claimId can be due in two rooms in
// one cron tick. A roomOf map keyed by bare claimId settles one room's
// lookup result against the wrong room's claim, where the PR URL matches no
// open link, so commitPullRequestLookup() no-ops and that room's merged PR
// is never settled (starved every tick). The single-room PR journeys in
// tests/work-claim-pr-link.test.js cannot reach this cross-room boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests } from "../server/claim-pr-sync.mjs";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const PRA = "https://github.com/Uuriko/project-room/pull/1600";
const PRB = "https://github.com/Uuriko/project-room/pull/1601";

function claimWithPr(registry, roomId, owner, prUrl) {
  let item = claimWork(createWork({ id: "X" }, { now: NOW, agentId: owner }),
    owner, { now: NOW, leaseHours: 1 });
  item = appendWorkPullRequest(item, owner, {
    pullRequest: prUrl, expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item), now: NOW,
  });
  registry.set(roomId, item);
}

const mergedFetch = async url => ({
  status: 200, ok: true, headers: { get: () => null },
  json: async () => {
    assert.ok(url.includes("api.github.com"), `unexpected fetch: ${url}`);
    return { state: "closed", merged: true, head: { sha: "a".repeat(40) }, merge_commit_sha: "b".repeat(40) };
  },
});

test("cron settles the same claimId in two rooms against its own room", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  const store = { db, workClaims: registry };
  claimWithPr(registry, "room-a", "alice", PRA);
  claimWithPr(registry, "room-b", "bob", PRB);

  const summary = await syncClaimPullRequests(store, { fetchImpl: mergedFetch, nowMs: NOW, token: "t" });
  assert.equal(summary.checked, 2);

  const a = registry.get("room-a", "X");
  const b = registry.get("room-b", "X");
  assert.equal(a.state, "done", `room-a's merged PR was never settled (state=${a.state})`);
  assert.equal(b.state, "done", `room-b's merged PR was never settled (state=${b.state})`);
});
