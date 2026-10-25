// #3698: claim-prs housekeeping enumerated the whole claim registry before
// the tick's first deadline check. At ~20k claims the three phases consumed
// the entire 5s budget, the poll never ran, and the tick returned
// budgetExceeded — which the job heartbeat counts as cooperative progress,
// so PR settlement would stall indefinitely behind a green-looking job.
// These tests pin the fix: phases SQL-select their candidate rows, check
// the deadline before and during their work, resume across ticks, and a
// tick whose housekeeping cannot finish is a failure, not progress.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests, sweepStaleUnclaimedClaims } from "../server/claim-pr-sync.mjs";
import { summaryFailure } from "../cloudflare/job-heartbeat.mjs";
import { SOURCE_REVISION } from "../server/version.mjs";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const HOUR = 3600_000;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  return { store: { db, workClaims: registry }, registry };
}

const noFetch = async () => { throw new Error("fetch must not be called"); };
const openFetch = async () => ({
  status: 200, ok: true, headers: { get: () => null },
  text: async () => JSON.stringify({ state: "open", merged: false, head: { sha: "a".repeat(40) } })
});

// The report's probe shape: 200 rooms x 100 claims of ~700 B item JSON.
function seedRegistryScale(registry, rooms = 200, perRoom = 100) {
  const pad = "x".repeat(420);
  for (let room = 0; room < rooms; room++) {
    const roomId = `room-${String(room).padStart(3, "0")}`;
    for (let i = 0; i < perRoom; i++) {
      registry.set(roomId, createWork(
        { id: `claim-${i}`, title: `Synthetic claim ${i}`, note: pad, tags: ["probe"] },
        { now: NOW - HOUR, agentId: "agent-seed" }
      ));
    }
  }
}

test("at registry scale an expired deadline returns at once and reads as failure, not progress", { timeout: 60000 }, async () => {
  const { store, registry } = setup();
  seedRegistryScale(registry);
  const started = Date.now();
  const out = await syncClaimPullRequests(store, { env: {}, token: null, fetchImpl: noFetch, nowMs: NOW, deadline: Date.now() - 1 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `expired-deadline tick took ${elapsed} ms; the deadline gate must precede housekeeping`);
  assert.equal(out.checked, 0, "the poll never ran");
  assert.equal(out.budgetExceeded, 1);
  assert.equal(out.errors, 1, "a housekeeping-starved tick is a failed tick");
  assert.equal(out.failureDetail?.code, "housekeeping_starved");
  assert.notEqual(summaryFailure(out), null, "the heartbeat must not count this tick as progress");
});

test("at registry scale with a live deadline the poll still runs and the tick is clean", { timeout: 60000 }, async () => {
  const { store, registry } = setup();
  seedRegistryScale(registry);
  let due = claimWork(
    createWork({ id: "due-claim" }, { now: NOW - HOUR, agentId: "agent-a" }),
    "agent-a", { now: NOW - HOUR, leaseHours: null });
  due = appendWorkPullRequest(due, "agent-a", {
    pullRequest: "https://github.com/Uuriko/project-room/pull/2479",
    expectedClaimedAt: due.claimedAt,
    expectedHistoryLength: claimHistoryLength(due),
    now: NOW - HOUR
  });
  registry.set("room-000", due);
  const out = await syncClaimPullRequests(store, {
    env: {}, token: null, fetchImpl: openFetch, nowMs: NOW, deadline: Date.now() + 120_000
  });
  assert.equal(out.checked, 1, "the due claim is polled at registry scale");
  assert.equal(out.errors, undefined);
  assert.equal(summaryFailure(out), null, "a completed tick still reads as progress");
});

test("a mid-sweep deadline stops the lease sweep; the next tick resumes it and each lease is released exactly once", { timeout: 60000 }, async () => {
  const { store, registry } = setup();
  const total = 300;
  for (let i = 0; i < total; i++) {
    const roomId = `lease-room-${i % 10}`;
    const item = claimWork(
      createWork({ id: `lease-${i}` }, { now: NOW - 3 * HOUR, agentId: "agent-w" }),
      "agent-w", { now: NOW - 3 * HOUR, leaseHours: 1 });
    registry.set(roomId, item);
  }
  const releasedCount = () => {
    let count = 0;
    for (let i = 0; i < total; i++) {
      const item = registry.get(`lease-room-${i % 10}`, `lease-${i}`);
      if (item.state === "unclaimed") count += 1;
    }
    return count;
  };
  // A 1 ms budget cannot cover 300 releases; the sweep must stop and the
  // tick must report the starvation instead of polling past unswept leases.
  const first = await syncClaimPullRequests(store, {
    env: {}, token: null, fetchImpl: noFetch, nowMs: NOW, deadline: Date.now() + 1
  });
  assert.equal(first.errors, 1);
  assert.equal(first.budgetExceeded, 1);
  assert.ok(releasedCount() < total, "the first tick stopped mid-sweep");
  const second = await syncClaimPullRequests(store, {
    env: {}, token: null, fetchImpl: noFetch, nowMs: NOW, deadline: Date.now() + 120_000
  });
  assert.equal(second.errors, undefined);
  assert.equal(releasedCount(), total, "the second tick finished the sweep");
  for (let i = 0; i < total; i++) {
    const item = registry.get(`lease-room-${i % 10}`, `lease-${i}`);
    assert.equal(item.history.filter(entry => entry.action === "lease_expired").length, 1,
      `lease-${i} was released exactly once`);
  }
  // A third tick is a no-op: nothing is re-released or re-stamped.
  const before = registry.get("lease-room-0", "lease-0").history.length;
  await syncClaimPullRequests(store, { env: {}, token: null, fetchImpl: noFetch, nowMs: NOW, deadline: Date.now() + 120_000 });
  assert.equal(registry.get("lease-room-0", "lease-0").history.length, before);
});

test("deployed closes come from the candidate pass, not the validation rotation; poison is still named", { timeout: 60000 }, async () => {
  const { store, registry } = setup();
  // Filler pushes the registry past one rotation slice (256 rows), so the
  // walk alone could not reach the late-sorting room on the first tick.
  for (let i = 0; i < 400; i++) {
    registry.set(`mmm-${String(i).padStart(3, "0")}`, createWork(
      { id: "filler" }, { now: NOW - HOUR, agentId: "agent-seed" }));
  }
  // A malformed row in the earliest-sorting room: the rotation names it.
  const poison = createWork({ id: "poison-claim" }, { now: NOW - HOUR, agentId: "agent-b" });
  registry.set("aaa-bad", { ...poison, repo: "https://github.com/Uuriko/project-room" });
  // A land claim whose revision is live, in the latest-sorting room.
  const land = createWork(
    { id: "landed", kind: "land", revision: SOURCE_REVISION },
    { now: NOW - HOUR, agentId: "agent-a" });
  registry.set("zzz-land", land);
  const out = await syncClaimPullRequests(store, {
    env: {}, token: null, fetchImpl: noFetch, nowMs: NOW, deadline: Date.now() + 120_000
  });
  assert.equal(registry.get("zzz-land", "landed").state, "done",
    "the deployed close happened on this tick, without waiting for the rotation");
  assert.equal(out.errors, undefined);
  assert.equal(out.skippedInvalid, 1, "the malformed row is still skipped and named");
  assert.equal(out.skippedInvalidItems[0].claimId, "poison-claim");
});

test("the stale sweep reports an unfinished pass when the deadline cuts it", { timeout: 60000 }, async () => {
  const { store, registry } = setup();
  registry.configure("room-x", { staleSweep: true });
  const old = NOW - 30 * 24 * HOUR;
  registry.set("room-x", createWork({ id: "dormant" }, { now: old, agentId: "agent-c" }));
  const progress = {};
  const closed = sweepStaleUnclaimedClaims(store, NOW, {
    force: true, deadline: Date.now() - 1, progress
  });
  assert.equal(closed, 0);
  assert.equal(progress.complete, false, "the caller hears the pass did not finish");
  assert.equal(registry.get("room-x", "dormant").state, "unclaimed");
  const closedLater = sweepStaleUnclaimedClaims(store, NOW, { force: true, deadline: Date.now() + 120_000 });
  assert.equal(closedLater, 1, "the next pass closes the dormant row");
});
