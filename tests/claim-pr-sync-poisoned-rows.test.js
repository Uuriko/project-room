// #3464 / #3465: one stored claim row with a malformed `repo` wedged the
// production claim-prs sweep from 2026-10-13T23:57Z onward (380+ consecutive
// failed ticks, checked:0). The durable registry decodes rows WITHOUT
// validation while every state-machine touch re-validates, and the sweep's
// first phase touches every row in every room — so a single poisoned row
// (written verbatim by the work-item-board backfill from the projection's
// free-form `repository`, #3465) aborted the whole tick before any polling.
// These tests pin the two-sided fix: the sweep skips and NAMES invalid rows
// per item instead of wedging, and the backfill validates mapped rows
// through the state machine and never stores an invalid one.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests, sweepStaleUnclaimedClaims } from "../server/claim-pr-sync.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const NOW = Date.UTC(2026, 9, 14, 19, 0, 0);
const HOUR = 3600_000;
const REPO_ERROR = /repo must be 1\.\.200 characters/;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  return { store: { db, workClaims: registry }, registry };
}

function seedGoodDue(registry, roomId = "aaa-good") {
  let item = claimWork(
    createWork({ id: "good-claim" }, { now: NOW - HOUR, agentId: "agent-a" }),
    "agent-a", { now: NOW - HOUR, leaseHours: null });
  item = appendWorkPullRequest(item, "agent-a", {
    pullRequest: "https://github.com/Uuriko/project-room/pull/2479",
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item),
    now: NOW - HOUR
  });
  registry.set(roomId, item);
}

// Written exactly the way the pre-fix backfill wrote: straight through
// registry.set(), never through the state machine.
function seedPoison(registry, repo, { roomId = "zzz-bad", id = "poison-claim", mutate = null } = {}) {
  const base = createWork({ id }, { now: NOW - HOUR, agentId: "agent-b" });
  registry.set(roomId, mutate ? mutate({ ...base, repo }) : { ...base, repo });
}

const openFetch = calls => async url => {
  calls.push(String(url));
  return {
    status: 200, ok: true, headers: { get: () => null },
    text: async () => JSON.stringify({ state: "open", merged: false, head: { sha: "a".repeat(40) } })
  };
};

test("one malformed-repo row no longer wedges the sweep; it is skipped and named", async () => {
  const { store, registry } = setup();
  seedGoodDue(registry);
  seedPoison(registry, "https://github.com/Uuriko/project-room");
  const calls = [];
  const out = await syncClaimPullRequests(store, { fetchImpl: openFetch(calls), nowMs: NOW, token: null, env: {} });
  assert.equal(out.checked, 1, "the good room's due claim is still polled");
  assert.ok(calls.length >= 1, "GitHub was actually called");
  assert.equal(out.skippedInvalid, 1);
  assert.equal(out.skippedInvalidItems[0].roomId, "zzz-bad");
  assert.equal(out.skippedInvalidItems[0].claimId, "poison-claim");
  assert.match(out.skippedInvalidItems[0].error, REPO_ERROR);
});

test("control: without the poisoned row the same store sweeps clean", async () => {
  const { store, registry } = setup();
  seedGoodDue(registry);
  const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
  assert.equal(out.checked, 1);
  assert.equal(out.skippedInvalid, undefined);
});

for (const [label, repo] of [
  ["ssh form", "git@github.com:Uuriko/project-room.git"],
  ["space in name", "Uuriko/project room"],
  ["201 chars", "a".repeat(201)],
  ["non-string", 123],
  ["tilde path", "~/project-room"]
]) {
  test(`poison shape is skipped, not fatal: ${label}`, async () => {
    const { store, registry } = setup();
    seedGoodDue(registry);
    seedPoison(registry, repo);
    const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
    assert.equal(out.checked, 1);
    assert.equal(out.skippedInvalid, 1);
  });
}

for (const repo of ["Uuriko/project-room", "github.com/Uuriko/project-room", "Uuriko/project-room.git"]) {
  test(`valid stored repo shape sweeps without a skip: ${repo}`, async () => {
    const { store, registry } = setup();
    seedGoodDue(registry);
    seedPoison(registry, repo);
    const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
    assert.equal(out.checked, 1);
    assert.equal(out.skippedInvalid, undefined);
  });
}

test("expired-lease poison is skipped while a valid expired lease still releases", async () => {
  const { store, registry } = setup();
  const expiredClaim = (id, owner) => claimWork(
    createWork({ id }, { now: NOW - 3 * HOUR, agentId: owner }),
    owner, { now: NOW - 3 * HOUR, leaseHours: 1 });
  registry.set("room-a", { ...expiredClaim("poison-lease", "agent-b"), repo: "https://github.com/Uuriko/project-room" });
  registry.set("room-b", expiredClaim("good-lease", "agent-c"));
  const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
  assert.equal(registry.get("room-b", "good-lease").state, "unclaimed", "the valid lapsed lease is released");
  assert.equal(registry.get("room-a", "poison-lease").state, "claimed", "the invalid row is left for operator cleanup, untouched");
  assert.ok(out.skippedInvalid >= 1, "the poisoned lease row is reported");
  assert.ok(out.skippedInvalidItems.some(entry => entry.claimId === "poison-lease"));
});

test("stale-unclaimed sweep: a dormant poisoned row is named while the valid dormant row closes", async () => {
  const { store, registry } = setup();
  registry.configure("room-x", { staleSweep: true });
  const old = NOW - 30 * 24 * HOUR;
  registry.set("room-x", { ...createWork({ id: "dormant-poison" }, { now: old, agentId: "agent-b" }), repo: "Uuriko/project room" });
  registry.set("room-x", createWork({ id: "dormant-valid" }, { now: old, agentId: "agent-c" }));
  const skipped = [];
  const closed = sweepStaleUnclaimedClaims(store, NOW, { force: true, skipped });
  assert.equal(closed, 1);
  assert.equal(registry.get("room-x", "dormant-valid").state, "closed");
  assert.equal(registry.get("room-x", "dormant-poison").state, "unclaimed");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].claimId, "dormant-poison");
  assert.match(skipped[0].error, REPO_ERROR);
});

test("backfill validates mapped rows: a URL repository is reported, never stored (#3465)", t => {
  const dir = mkdtempSync(join(tmpdir(), "claimprs-writer-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { workItemBoardBackfill: "manual" });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-worker", type: "member.added",
    data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] }
  });
  const workerKey = store.issueAccessKey("commons", "worker");
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const revisionOf = id => store.room("commons").state.workItems[id].revision;
  const drive = (workItemId, repository) => {
    send(ownerKey, `propose-${workItemId}`, "work.proposed", {
      workItemId, title: `Task ${workItemId}`, definitionOfDone: "Done", accountableMemberId: "worker", mode: "write"
    });
    send(workerKey, `accept-${workItemId}`, "work.accepted", { workItemId, expectedRevision: revisionOf(workItemId) });
    send(workerKey, `claim-${workItemId}`, "claim.acquired", {
      workItemId, expectedRevision: revisionOf(workItemId),
      repository, ref: "main", paths: ["server/**"], expiresAt: new Date(Date.now() + 2 * HOUR).toISOString()
    });
  };
  drive("task-url", "https://github.com/Uuriko/project-room");
  drive("task-ok", "Uuriko/project-room");
  // Stage the legacy state: board rows gone, backfill rebuilds from the log.
  store.db.prepare("DELETE FROM work_claims WHERE room_id='commons'").run();
  const report = store.backfillRoomWorkItemClaims("commons");
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /task-url/);
  assert.match(report.errors[0], REPO_ERROR);
  assert.equal(store.workClaims.get("commons", "task-url"), null, "the invalid row is not stored");
  assert.equal(store.workClaims.get("commons", "task-ok")?.state, "claimed", "the valid row is stored");
  assert.equal(report.created, 1);
});
