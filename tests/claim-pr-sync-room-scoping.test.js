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
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength, releaseWork, renewWork, reassignWork, updateWork } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests } from "../server/claim-pr-sync.mjs";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const PRA = "https://github.com/Uuriko/project-room/pull/1600";
const PRB = "https://github.com/Uuriko/project-room/pull/1601";

function claimWithPr(registry, roomId, owner, prUrl) {
  let item = claimWork(createWork({ id: "X" }, { now: NOW, agentId: owner }),
    owner, { now: NOW, leaseHours: null });
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

// Room seq 8117: a GitHub response fetched for round A must not retire or
// complete round B. Retry tests cover one round, not a release/reclaim
// while the real cron awaits its provider response. The GitHub boundary
// refuses unexpected URLs; the SQLite registry and cron are real.
const API = "https://api.github.com/repos/Uuriko/project-room/pulls/1600";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  t.after(() => db.close());
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  let item = claimWork(createWork({ id: "race" }, { now: NOW, agentId: "alice" }),
    "alice", { now: NOW });
  item = appendWorkPullRequest(item, "alice", {
    pullRequest: PRA, expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item), now: NOW,
  });
  registry.set("race-room", item);
  return { db, workClaims: registry };
}

function response(merged) {
  return { status: 200, ok: true, headers: { get: () => null },
    json: async () => ({ state: "closed", merged, head: { sha: "a".repeat(40) }, merge_commit_sha: merged ? "b".repeat(40) : null }) };
}

for (const merged of [false, true]) {
  for (const owner of ["alice", "bob"]) {
    test(`stale ${merged ? "merged" : "closed"} lookup cannot settle a same-millisecond new round owned by ${owner}`, async t => {
      const store = fixture(t);
      let fresh;
      const fetchImpl = async url => {
        assert.equal(String(url), API, "unexpected provider request");
        let item = store.workClaims.get("race-room", "race");
        item = releaseWork(item, "alice", {
          expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: NOW,
        });
        fresh = claimWork(item, owner, { now: NOW });
        store.workClaims.set("race-room", fresh);
        return response(merged);
      };
      const summary = await syncClaimPullRequests(store, { fetchImpl, nowMs: NOW, token: "test" });
      assert.equal(summary.updated, 0, "an obsolete observation must not settle");
      assert.deepEqual(store.workClaims.get("race-room", "race"), fresh,
        "the new round keeps its owner, lease, files and unstamped PR");
    });
  }
}

test("same-round renewal while GitHub responds still permits current settlement", async t => {
  const store = fixture(t);
  const fetchImpl = async url => {
    assert.equal(String(url), API, "unexpected provider request");
    const current = store.workClaims.get("race-room", "race");
    store.workClaims.set("race-room", renewWork(current, "alice", { now: NOW + 1, note: "still working" }));
    return response(true);
  };
  const summary = await syncClaimPullRequests(store, { fetchImpl, nowMs: NOW + 2, token: "test" });
  assert.equal(summary.updated, 1);
  const final = store.workClaims.get("race-room", "race");
  assert.equal(final.state, "done");
  assert.equal(final.owner, "alice");
  assert.equal(final.history.filter(entry => entry.action === "renewed").length, 1);
});

for (const transition of ["reassigned away and back", "round change trimmed from history"]) {
  test(`stale closed lookup is refused after ${transition}`, async t => {
    const store = fixture(t);
    let fresh;
    const fetchImpl = async url => {
      assert.equal(String(url), API, "unexpected provider request");
      let item = store.workClaims.get("race-room", "race");
      if (transition === "reassigned away and back") {
        item = reassignWork(item, "alice", "bob", { now: NOW });
        fresh = reassignWork(item, "bob", "alice", { now: NOW });
      } else {
        item = releaseWork(item, "alice", {
          expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item), now: NOW,
        });
        fresh = claimWork(item, "alice", { now: NOW });
        for (let i = 0; i < 210; i += 1) fresh = updateWork(fresh, "alice", { note: `progress ${i}`, now: NOW });
      }
      store.workClaims.set("race-room", fresh);
      return response(false);
    };
    const summary = await syncClaimPullRequests(store, { fetchImpl, nowMs: NOW, token: "test" });
    assert.equal(summary.updated, 0);
    assert.deepEqual(store.workClaims.get("race-room", "race"), fresh);
  });
}
