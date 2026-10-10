// #1526: the per-minute settlement cron and the PR webhook both settle
// through commitPullRequestLookup. A merged PR must settle a claim exactly
// once: the second path to act (webhook after cron, or cron after webhook)
// re-reads the claim inside its own transaction, sees the recorded outcome,
// and no-ops instead of re-settling (no duplicate pr_merged event, no
// reputation/journal swing, no stale owner).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { commitPullRequestLookup } from "../server/claim-pr-sync.mjs";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const URL = "https://github.com/Uuriko/project-room/pull/1700";

function liveClaim() {
  return {
    id: "race-claim",
    title: "race claim",
    state: "claimed",
    owner: "alice",
    files: [],
    history: [],
    pullRequest: { url: URL, repo: "Uuriko/project-room", number: 1700 },
    pullRequests: [{ url: URL, repo: "Uuriko/project-room", number: 1700 }],
  };
}

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  return store;
}

for (const [first, second] of [["webhook", "cron"], ["cron", "webhook"]]) {
  test(`#1526: ${first} settles, then ${second} replays the same merged PR as a no-op`, t => {
    const store = fixture(t);
    store.workClaims.set("commons", liveClaim());
    const fresh = () => store.workClaims.get("commons", "race-claim");
    const result = { claimId: "race-claim", url: URL, kind: "merged" };

    assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", fresh(), result, NOW), true,
      `${first} path settles the claim`);
    const settled = fresh();
    assert.equal(settled.state, "done");
    assert.equal(settled.pullRequest.outcome, "merged");
    const historyLength = settled.history.length;

    assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", fresh(), result, NOW + 1000), false,
      `${second} path sees the recorded outcome and does not re-settle`);
    const after = fresh();
    assert.equal(after.state, "done");
    assert.equal(after.history.length, historyLength, "no duplicate settlement history stamp");
    assert.equal(after.pullRequest.outcome, "merged");
  });
}

test("#1526: a close racing a merge settles once with the first recorded outcome", t => {
  const store = fixture(t);
  store.workClaims.set("commons", liveClaim());
  const fresh = () => store.workClaims.get("commons", "race-claim");
  assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", fresh(),
    { claimId: "race-claim", url: URL, kind: "closed" }, NOW), true);
  assert.equal(fresh().state, "unclaimed");
  assert.equal(fresh().owner, null);
  // The late merge report for the same PR is a no-op: the claim was already
  // released by the close, so no stale owner can block a re-claim.
  assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", fresh(),
    { claimId: "race-claim", url: URL, kind: "merged" }, NOW + 1000), false);
  assert.equal(fresh().state, "unclaimed");
  assert.equal(fresh().owner, null);
});
