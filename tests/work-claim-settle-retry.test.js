// QA200 challenge of PR #2032 (settle double-apply terminality).
//
// #2032 hardens settlePullRequest's terminal-state guard for the sequential
// shape: a second settle threaded through the first call's output returns
// null. But commitPullRequestLookup — the settlement path the cron tick and
// the webhook both call — settled whatever item object the caller handed it.
// A caller retrying after a lost response (retry-after-timeout) re-submits
// the pre-settle item, and the retry applied a SECOND pr_merged: a duplicate
// room event plus a duplicate pr_merged history stamp on the row.
//
// Contract: committing the same lookup result twice with a stale item must
// settle exactly once. The commit reads the freshest registered row first, so
// the retry finds the links already stamped and returns false.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Observable contract: two commitPullRequestLookup calls with the same
//    pre-settle item and result emit exactly one pr_merged event; the row
//    carries exactly one pr_merged history stamp; the retry returns false.
// 2. Credible regression: reproduced on origin/main 2026-10-08 — the retry
//    emitted 2 pr_merged events and stamped history twice.
// 3. Existing coverage: nothing asserted commit-level retry idempotency.
// 4. No test-only seam: the real exported commit path against a real
//    RoomStore (sqlite), with the real event log counted.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { commitPullRequestLookup } from "../server/claim-pr-sync.mjs";
import {
  createWork, claimWork, appendWorkPullRequest, claimHistoryLength,
} from "../server/work-claims.mjs";

const PR = "https://github.com/Uuriko/project-room/pull/2032";
const ROOM = "ch-settle-retry";
const NOW = Date.UTC(2026, 9, 8, 9, 30, 0);

function openClaim(id) {
  const item = claimWork(createWork({ id }, { now: NOW, agentId: "alice" }), "alice", { now: NOW });
  return appendWorkPullRequest(item, "alice", {
    pullRequest: PR,
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item),
    now: NOW,
  });
}

function prMergedEvents(store) {
  return store.db.prepare("SELECT body FROM events WHERE room_id=?").all(ROOM)
    .filter(row => {
      try { return JSON.parse(row.body).data?.action === "pr_merged"; } catch { return false; }
    });
}

test("retry-after-timeout: a stale-item retry of the same merged lookup settles exactly once", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());

  const item = openClaim("retry-claim");
  store.workClaims.set(ROOM, item);
  const result = { claimId: "retry-claim", url: PR, kind: "merged" };

  assert.equal(commitPullRequestLookup(store, store.workClaims, ROOM, item, result, NOW), true,
    "the first commit settles");
  // The caller's response was lost; it retries with the same pre-settle item.
  assert.equal(commitPullRequestLookup(store, store.workClaims, ROOM, item, result, NOW + 1000), false,
    "the stale retry must not settle again");

  assert.equal(prMergedEvents(store).length, 1,
    "exactly one pr_merged room event may be emitted");
  const final = store.workClaims.get(ROOM, "retry-claim");
  assert.equal(final.state, "done");
  assert.equal(final.history.filter(step => step?.action === "pr_merged").length, 1,
    "the row must carry exactly one pr_merged history stamp");
});

test("retry-after-timeout: a stale-item retry of the same closed lookup releases exactly once", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());

  const item = openClaim("retry-closed");
  store.workClaims.set(ROOM, item);
  const result = { claimId: "retry-closed", url: PR, kind: "closed" };

  assert.equal(commitPullRequestLookup(store, store.workClaims, ROOM, item, result, NOW), true,
    "the first commit releases");
  assert.equal(commitPullRequestLookup(store, store.workClaims, ROOM, item, result, NOW + 1000), false,
    "the stale retry must not release again");

  const closed = store.db.prepare("SELECT body FROM events WHERE room_id=?").all(ROOM)
    .filter(row => {
      try { return JSON.parse(row.body).data?.action === "pr_closed"; } catch { return false; }
    });
  assert.equal(closed.length, 1, "exactly one pr_closed room event may be emitted");
  assert.equal(store.workClaims.get(ROOM, "retry-closed").state, "unclaimed");
});
