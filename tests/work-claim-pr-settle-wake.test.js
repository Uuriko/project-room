// PR-settlement mention wakes.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Observable contract: when a linked pull request closes UNMERGED, the
//    claim is auto-released out from under its owner (owner cleared, lease
//    cleared, files freed, attestations cleared). The owner must get a
//    mention-wake naming the claim and the pr_closed reason — the same
//    treatment a lease expiry already gets (work-claim:{id}:lease_expired).
//    Without it the lane discovers the lost claim only by polling.
// 2. Credible regression: a later edit to commitPullRequestLookup's settle
//    branch (the one place the /sweep route, the per-minute cron and the
//    webhook path all funnel through) drops the wake; the room event still
//    lands, so only this test notices the silence.
// 3. Existing coverage: tests/board-wake.test.js covers assigned and
//    lease_expired wakes; nothing covers pr_closed/pr_merged settlement.
//    tests/work-claim-batch-outcome.test.js covers the settled STATE, not
//    the wake.
// 4. No test-only seam: the real commitPullRequestLookup, the real
//    RoomStore, the real wake queue table.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { commitPullRequestLookup } from "../server/claim-pr-sync.mjs";
import {
  createWork, claimWork, appendWorkPullRequest, claimHistoryLength,
} from "../server/work-claims.mjs";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const PR = "https://github.com/Uuriko/project-room/pull/1700";

function fixture() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  return store;
}

function claimWithPr(store, id, owner) {
  let item = claimWork(
    createWork({ id, files: ["server/a.mjs"] }, { now: NOW, agentId: owner }),
    owner, { now: NOW, leaseHours: null });
  item = appendWorkPullRequest(item, owner, {
    pullRequest: PR,
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item),
    now: NOW,
  });
  store.workClaims.set("commons", item);
  return item;
}

const wakeMessageIds = store =>
  store.db.prepare("SELECT message_id AS id FROM agent_wake_signals").all().map(row => row.id);

test("a PR that closes unmerged wakes the previous owner (pr_closed)", t => {
  const store = fixture();
  t.after(() => store.close());
  const item = claimWithPr(store, "prw-1", "owner");

  const settled = commitPullRequestLookup(store, store.workClaims, "commons", item,
    { claimId: "prw-1", url: PR, kind: "closed" }, NOW);
  assert.equal(settled, true, "the closed PR settles the claim");

  const final = store.workClaims.get("commons", "prw-1");
  assert.equal(final.state, "unclaimed");
  assert.equal(final.owner, null);

  const ids = wakeMessageIds(store);
  assert.ok(ids.some(id => id.startsWith("work-claim:prw-1:pr_closed:")),
    `the previous owner must be woken about the pr_closed release; wakes: ${JSON.stringify(ids)}`);
});

test("a second settle of the same close does not double-wake", t => {
  const store = fixture();
  t.after(() => store.close());
  const item = claimWithPr(store, "prw-2", "owner");

  assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", item,
    { claimId: "prw-2", url: PR, kind: "closed" }, NOW), true);
  const wakesAfterFirst = wakeMessageIds(store)
    .filter(id => id.startsWith("work-claim:prw-2:pr_closed:")).length;
  assert.equal(wakesAfterFirst, 1);

  // The lookup result replays (double poll, webhook + tick): callers re-read
  // the row, the link already carries its outcome, so the settle is a no-op
  // and no second wake fires.
  const reread = store.workClaims.get("commons", "prw-2");
  assert.equal(commitPullRequestLookup(store, store.workClaims, "commons", reread,
    { claimId: "prw-2", url: PR, kind: "closed" }, NOW + 1000), false);
  const wakesAfterSecond = wakeMessageIds(store)
    .filter(id => id.startsWith("work-claim:prw-2:pr_closed:")).length;
  assert.equal(wakesAfterSecond, 1, "a replayed close must not wake again");
});
