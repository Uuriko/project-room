// Archived rooms vs the batch claim writers (Q03-F1, Codex patch-first
// ruling on #5502, muse-room 25696).
//
// #5502 froze the work-claim registry for archived rooms: set() refuses
// with room_archived. Three batch writers still selected and wrote
// archived rooms' rows with no isolation, so one archived room denied
// the batch for every room:
//
//   1. claim-autolink linkDeployToSettledClaims looped every room in
//      ONE transaction — the archived room's set threw and the whole
//      transaction rolled back, leaving live rooms' settled claims
//      unlinked (executed probe, evidence/5502-pack-1101).
//   2. claim-pr-sync's candidate loaders had no archived exclusion
//      before their LIMIT cap, so archived rows starved live due
//      claims tick after tick and fed uncaught set loops (holdDue).
//   3. land-queue migrateLandQueueClaims swallowed only
//      too_many_open_claims per row — a room_archived throw broke the
//      migration, and the list() that runs it, for every room.
//
// The fix mirrors the public-namespace shape the codebase already
// carries: exclude archived rooms in SQL before the candidate LIMIT,
// skip them per row as a backstop, and catch room_archived around the
// remaining batch set loops. Receipts are retained: a live room's link
// still writes its item and its deploy_linked history stamp; the
// archived room's rows are left exactly as they were.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { linkDeployToSettledClaims, autoLinkPullRequest } from "../server/claim-autolink.mjs";
import { syncClaimPullRequests } from "../server/claim-pr-sync.mjs";
import { migrateLandQueueClaims } from "../server/land-queue.mjs";

const REV = "d".repeat(40);
const NOW = 1_700_000_000_000;

function twoRoomStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("live-room"));
  store.initialize(initialRoom("archived-room"));
  t.after(() => store.close());
  return store;
}

function archive(store, roomId) {
  // Stamp the SQL mirror the guard reads, as command() does when a
  // room archives — after the room's claims are already recorded.
  store.db.prepare("UPDATE rooms SET archived_at=? WHERE id=?")
    .run("2026-11-01T00:00:00.000Z", roomId);
}

const settledItem = id => ({ id, kind: "land", state: "done", revision: REV, owner: "owner", history: [] });

// --- claim-autolink: the executed probe, as a regression test --------

test("linkDeployToSettledClaims: one archived room does not deny deploy linking for live rooms", t => {
  const store = twoRoomStore(t);
  // The archived room's claim is inserted FIRST, so the batch reaches
  // the bad row before the live room's row.
  store.workClaims.set("archived-room", settledItem("lane-archived"));
  store.workClaims.set("live-room", settledItem("lane-live"));
  archive(store, "archived-room");

  const out = linkDeployToSettledClaims(store, { revision: REV, nowMs: NOW });
  assert.equal(out.linked, 1, "the live room's claim links");
  const live = store.workClaims.get("live-room", "lane-live");
  assert.equal(live.deploy?.revision, REV);
  assert.ok(live.history.some(entry => entry.action === "deploy_linked"),
    "the live link keeps its history receipt");
  const archived = store.workClaims.get("archived-room", "lane-archived");
  assert.equal(archived.deploy, undefined, "the archived room's claim stays unlinked");
  assert.ok(!archived.history.some(entry => entry.action === "deploy_linked"));
});

test("linkDeployToSettledClaims: archived-only batch links nothing and does not throw", t => {
  const store = twoRoomStore(t);
  store.workClaims.set("archived-room", settledItem("lane-archived"));
  archive(store, "archived-room");
  const out = linkDeployToSettledClaims(store, { revision: REV, nowMs: NOW });
  assert.equal(out.linked, 0);
});

test("linkDeployToSettledClaims: no archived rooms links every settled claim (control)", t => {
  const store = twoRoomStore(t);
  store.workClaims.set("archived-room", settledItem("lane-archived"));
  store.workClaims.set("live-room", settledItem("lane-live"));
  const out = linkDeployToSettledClaims(store, { revision: REV, nowMs: NOW });
  assert.equal(out.linked, 2);
});

test("autoLinkPullRequest: an archived room refuses cleanly instead of throwing inside the batch", t => {
  const store = twoRoomStore(t);
  const live = claimWork(createWork({ id: "link-live", title: "live" }, { now: Date.now(), agentId: "owner" }),
    "owner", { leaseHours: null, now: Date.now() });
  store.workClaims.set("live-room", live);
  const frozen = claimWork(createWork({ id: "link-frozen", title: "frozen" }, { now: Date.now(), agentId: "owner" }),
    "owner", { leaseHours: null, now: Date.now() });
  store.workClaims.set("archived-room", frozen);
  archive(store, "archived-room");

  const refused = autoLinkPullRequest(store, "archived-room", "link-frozen",
    { url: "https://github.com/Uuriko/project-room/pull/7" }, { nowMs: Date.now() });
  assert.deepEqual(refused, { linked: false, reason: "room_archived" });
  const linked = autoLinkPullRequest(store, "live-room", "link-live",
    { url: "https://github.com/Uuriko/project-room/pull/8" }, { nowMs: Date.now() });
  assert.equal(linked.linked, true, "the live room still links");
});

// --- claim-pr-sync: archived rows must not consume the candidate cap --

const MERGED_BODY = { state: "closed", merged: true, head: { sha: "a".repeat(40) }, merge_commit_sha: "b".repeat(40) };
const mergedFetch = async () => ({
  status: 200, ok: true, headers: { get: () => null },
  text: async () => JSON.stringify(MERGED_BODY), json: async () => MERGED_BODY
});

function dueClaim(store, roomId, id, pullNumber) {
  const claimed = claimWork(createWork({ id, title: id }, { now: Date.now(), agentId: "owner" }),
    "owner", { leaseHours: null, now: Date.now() });
  const linked = appendWorkPullRequest(claimed, "owner", {
    pullRequest: `https://github.com/Uuriko/project-room/pull/${pullNumber}`,
    expectedClaimedAt: claimed.claimedAt,
    expectedHistoryLength: claimHistoryLength(claimed),
    now: Date.now()
  });
  store.workClaims.set(roomId, linked);
  return linked;
}

test("claim-pr-sync: archived due claims neither starve nor roll back a live room's settlement", async t => {
  const store = twoRoomStore(t);
  // 33 due claims in the soon-to-be-archived room — one more than the
  // 32-row candidate cap — then the live room's due claim last.
  for (let i = 0; i < 33; i += 1) dueClaim(store, "archived-room", `due-archived-${i}`, 2000 + i);
  dueClaim(store, "live-room", "due-live", 3000);
  archive(store, "archived-room");

  const out = await syncClaimPullRequests(store, {
    env: {}, fetchImpl: mergedFetch, nowMs: Date.now() + 60_000, token: null
  });
  assert.equal(out.updated, 1, "the live claim settles in the same tick");
  const live = store.workClaims.get("live-room", "due-live");
  assert.equal(live.pullRequest?.outcome, "merged");
  for (let i = 0; i < 33; i += 1) {
    const item = store.workClaims.get("archived-room", `due-archived-${i}`);
    assert.equal(item.state, "claimed", "archived claims are not settled by the sync");
    assert.ok(item.pullRequest?.outcome == null, "archived claims gain no outcome stamp");
  }
});

test("claim-pr-sync: an archived room's lapsed lease does not abort the tick for live rooms", async t => {
  const store = twoRoomStore(t);
  const HOUR = 3600_000;
  const claimedAt = Date.now();
  for (const [roomId, id] of [["archived-room", "lease-archived"], ["live-room", "lease-live"]]) {
    const lapsed = claimWork(createWork({ id, title: id }, { now: claimedAt, agentId: "owner" }),
      "owner", { leaseHours: 1, now: claimedAt });
    store.workClaims.set(roomId, lapsed);
  }
  archive(store, "archived-room");
  // Pre-fix, the lease sweep selected the archived room's claim and its
  // release set threw room_archived out of the sweep, aborting the tick.
  const neverFetch = async () => { throw new Error("network must not be used"); };
  await syncClaimPullRequests(store, { env: {}, fetchImpl: neverFetch, nowMs: claimedAt + 2 * HOUR, token: null });
  assert.equal(store.workClaims.get("live-room", "lease-live").state, "unclaimed",
    "the live room's lapsed claim releases in the same tick");
  assert.equal(store.workClaims.get("archived-room", "lease-archived").state, "claimed",
    "the archived room's claim is left exactly as it was");
});

// --- land-queue: the migration skips an archived room per row ---------

function landRow(store, roomId, itemId, prNumber) {
  store.db.prepare(`INSERT INTO land_queue
    (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, mergeable, behind, checks_state, observed, created_at, updated_at)
    VALUES (?, ?, 'acme/demo', ?, 'owner', 'owner', 'unknown', 0, 'pending', 1, 1, 1)`)
    .run(roomId, itemId, prNumber);
}

test("migrateLandQueueClaims: one archived room does not break the mirror for live rooms", t => {
  const store = twoRoomStore(t);
  landRow(store, "archived-room", "lq_archived_1", 11);
  landRow(store, "live-room", "lq_live_1", 12);
  archive(store, "archived-room");

  const out = migrateLandQueueClaims(store);
  assert.equal(out.copied, 1, "only the live room's row mirrors");
  assert.ok(store.workClaims.get("live-room", "lq_live_1"), "live room's claim is mirrored");
  assert.equal(store.workClaims.get("archived-room", "lq_archived_1"), null,
    "the archived room's mirror stays pending");
});

test("migrateLandQueueClaims: no archived rooms mirrors every row (control)", t => {
  const store = twoRoomStore(t);
  landRow(store, "archived-room", "lq_archived_1", 11);
  landRow(store, "live-room", "lq_live_1", 12);
  const out = migrateLandQueueClaims(store);
  assert.equal(out.copied, 2);
});
