// T-2 (cure-claimprs): the public-claim writer fence aborts any write to a
// public-namespace claim row by a writer without the permit, and the
// claim-prs sync is not a permit writer. A public claim reaching a
// lifecycle transition only the sync performs (lease release, stale
// close, rate-limit hold, poll settle) aborted on the write — and
// because several phases perform that write uncaught inside a room or
// batch transaction, one lapsed public lease wedged every tick in prod
// from 2026-10-19T10:42:59Z (the tick died in housekeeping, checked
// stayed 0, settlement stamps froze). These tests pin the cure: the
// refused claim is skipped and recorded DURABLY (first/last seen,
// count, phase), every other claim proceeds, a second tick does not
// re-wedge, and the fence itself is neither weakened nor admitted to.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { syncClaimPullRequests, sweepStaleUnclaimedClaims, readClaimPullBudget } from "../server/claim-pr-sync.mjs";
import { withPublicWorkClaimWriter, verifyPublicWorkClaimFence } from "../server/public-work-claim-fence.mjs";

const NOW = Date.UTC(2026, 9, 19, 15, 0, 0);
const HOUR = 3600_000;

const mergedFetch = async () => ({
  status: 200, ok: true, headers: { get: () => null },
  text: async () => JSON.stringify({ state: "closed", merged: true, merged_at: "2026-10-19T14:00:00Z",
    merge_commit_sha: "b".repeat(40), head: { sha: "a".repeat(40) } })
});
const rateLimitFetch = async () => ({
  status: 403, ok: false,
  headers: { get: name => name === "x-ratelimit-remaining" ? "0"
    : name === "x-ratelimit-reset" ? String(Math.floor(NOW / 1000) + 3600) : null },
  text: async () => JSON.stringify({ message: "API rate limit exceeded" })
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "claimprs-fence-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  // A public task in room "commons" (mirrors public-work-claim-fence.test.js):
  // its claims live in a fence-protected namespace.
  store.projectOffers.create("commons", "owner", { requestId: "create", offerId: "public-fence", reviewerMemberIds: ["owner"],
    terms: { repositoryUrl: "https://github.com/Uuriko/project-room", kind: "project", title: "Fence proof",
      summary: "Disposable public task", acceptanceCriteria: ["Return an artifact"], reward: { kind: "unpaid" },
      approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", "public-fence", "publish", { requestId: "publish", expectedRevision: 1 });
  const task = store.publicWorkClaims.enable("commons", "owner", "public-fence", {
    requestId: "enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["src/public-proof.js"] });
  return { store, namespace: task.namespaceId };
}

function seedClaimed(store, roomId, { id, agentId, leaseHours, withPull = null, ageHours = 1 }) {
  let item = claimWork(
    createWork({ id }, { now: NOW - ageHours * HOUR, agentId }),
    agentId, { now: NOW - ageHours * HOUR, leaseHours });
  if (withPull) {
    item = appendWorkPullRequest(item, agentId, {
      pullRequest: withPull, expectedClaimedAt: item.claimedAt,
      expectedHistoryLength: claimHistoryLength(item), now: NOW - ageHours * HOUR });
  }
  if (roomId.startsWith("public_")) withPublicWorkClaimWriter(store, () => store.workClaims.set(roomId, item));
  else store.workClaims.set(roomId, item);
  return item;
}

function durableBlocks(store) {
  const row = store.db.prepare("SELECT config_json FROM work_claim_config WHERE room_id='_claim-pr-fence-blocks'").get();
  return row ? Object.values(JSON.parse(row.config_json).items) : [];
}

test("expired lease on a public claim no longer wedges the tick; the block is durable", async t => {
  const { store, namespace } = fixture(t);
  seedClaimed(store, namespace, { id: "pub-claim", agentId: "agent-pub", leaseHours: 1, ageHours: 3 });
  seedClaimed(store, "commons", { id: "good-claim", agentId: "agent-a", leaseHours: null,
    withPull: "https://github.com/Uuriko/project-room/pull/2479" });

  const tick1 = await syncClaimPullRequests(store, { fetchImpl: mergedFetch, nowMs: NOW, token: "test-token", env: {} });
  assert.equal(tick1.fenceBlocked, 1);
  assert.equal(tick1.fenceBlockedItems[0].claimId, "pub-claim");
  assert.equal(tick1.fenceBlockedItems[0].phase, "lease-sweep");
  assert.equal(tick1.fenceBlockedItems[0].count, 1);
  // The healthy claim was still polled and settled in the same tick —
  // before the cure this tick threw in housekeeping and checked stayed 0.
  assert.equal(store.workClaims.get("commons", "good-claim").state, "done");
  assert.equal(store.workClaims.get(namespace, "pub-claim").state, "claimed",
    "the refused claim is left untouched for operator resolution");

  const tick2 = await syncClaimPullRequests(store, { fetchImpl: mergedFetch, nowMs: NOW + 60_000, token: "test-token", env: {} });
  assert.equal(tick2.fenceBlocked, 1, "the second tick does not re-wedge and still reports the block");
  const blocks = durableBlocks(store);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].count, 2, "repeat sightings accumulate on the durable record");
  assert.equal(blocks[0].firstSeenAt, tick1.fenceBlockedItems[0].firstSeenAt);
  assert.ok(blocks[0].lastSeenAt > blocks[0].firstSeenAt);

  // The fence itself is untouched: still closed at rest, direct writes
  // to the namespace still abort.
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
  assert.throws(() => store.workClaims.set(namespace, createWork({ id: "unauthorized" })), /unsupported public claim writer/);
});

test("poll settle of a public claim is fence-blocked and recorded while a private claim settles", async t => {
  const { store, namespace } = fixture(t);
  seedClaimed(store, namespace, { id: "pub-claim", agentId: "agent-pub", leaseHours: null,
    withPull: "https://github.com/Uuriko/project-room/pull/3000" });
  seedClaimed(store, "commons", { id: "good-claim", agentId: "agent-a", leaseHours: null,
    withPull: "https://github.com/Uuriko/project-room/pull/2479" });

  const out = await syncClaimPullRequests(store, { fetchImpl: mergedFetch, nowMs: NOW, token: "test-token", env: {} });
  assert.equal(out.updated, 1);
  assert.equal(store.workClaims.get("commons", "good-claim").state, "done");
  assert.equal(store.workClaims.get(namespace, "pub-claim").state, "claimed");
  const blocks = durableBlocks(store);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].claimId, "pub-claim");
  assert.equal(blocks[0].phase, "poll-commit");
});

test("a rate-limit hold refused for a public claim does not roll back the batch or the budget row", async t => {
  const { store, namespace } = fixture(t);
  seedClaimed(store, namespace, { id: "pub-claim", agentId: "agent-pub", leaseHours: null,
    withPull: "https://github.com/Uuriko/project-room/pull/3000" });
  seedClaimed(store, "commons", { id: "good-claim", agentId: "agent-a", leaseHours: null,
    withPull: "https://github.com/Uuriko/project-room/pull/2479" });

  const out = await syncClaimPullRequests(store, { fetchImpl: rateLimitFetch, nowMs: NOW, token: "test-token", env: {} });
  assert.equal(out.rateLimited, true);
  // Before the cure the abort rolled the whole transaction back: the
  // private claim's hold was lost and the budget row never landed, so
  // the next tick re-entered and died the same way.
  assert.ok(store.workClaims.get("commons", "good-claim").pullRequest.rateLimitedUntil > NOW,
    "the private claim's rate-limit hold persisted");
  assert.ok(readClaimPullBudget(store) > NOW, "the shared budget row landed");
  const blocks = durableBlocks(store);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].phase, "rate-limit-hold");
});

test("stale sweep closes the private dormant claim and records the public one instead of aborting", async t => {
  const { store, namespace } = fixture(t);
  withPublicWorkClaimWriter(store, () => store.workClaims.configure(namespace, { staleSweep: true }));
  store.workClaims.configure("commons", { staleSweep: true });
  const old = { now: NOW - 30 * 24 * HOUR, agentId: "agent-pub" };
  withPublicWorkClaimWriter(store, () => store.workClaims.set(namespace, createWork({ id: "pub-dormant" }, old)));
  store.workClaims.set("commons", createWork({ id: "good-dormant" }, { now: NOW - 30 * 24 * HOUR, agentId: "agent-a" }));

  const skipped = [];
  const closed = sweepStaleUnclaimedClaims(store, NOW, { force: true, skipped });
  assert.equal(closed, 1);
  assert.equal(store.workClaims.get("commons", "good-dormant").state, "closed");
  assert.equal(store.workClaims.get(namespace, "pub-dormant").state, "unclaimed");
  assert.ok(skipped.some(entry => entry.claimId === "pub-dormant"));
  const blocks = durableBlocks(store);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].claimId, "pub-dormant");
  assert.equal(blocks[0].phase, "stale-sweep");
});
